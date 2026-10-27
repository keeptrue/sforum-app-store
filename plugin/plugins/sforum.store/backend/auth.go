package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	hostwire "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2/gen/sforum/host/v2"
	pluginwire "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2/gen/sforum/plugin/v2"
	protocolwire "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2/gen/sforum/protocol/v2"
)

// 「连接商城」的插件侧实现。
//
// 流程（计划 §3.1）：页面 → /auth/start（插件生成 PKCE，问商城要一个请求 id）→ 页面在新标签
// 打开商城的 /connect/{id} → 页面每 interval 秒 /auth/poll → 商城批准后插件用 verifier 兑换
// 令牌 → 写进宿主加密的 secret 设置 → 页面显示「已连接为 @x」。
//
// 三件事只有插件能做，也因此都在这一个文件里：
//  1. verifier 不出进程（内存 map，进程重启即作废，重新点一次即可）；
//  2. 兑换来的令牌直接进宿主的 SecretService，不落盘、不落日志；
//  3. 401 的语义在这里翻译成页面能懂的状态（连接失效 → 清 secret → 重新连接）。

const (
	authModeAnonymous       = "anonymous"
	authModeAccountRequired = "account_required"
	// authModeUnsupported 是插件的说法，不是商城的：旧商城没有 /api/v1/auth/mode（404），
	// 页面据此隐藏连接 UI，安装照旧匿名。
	authModeUnsupported = "unsupported"

	authStatusPending   = "pending"
	authStatusApproved  = "approved"
	authStatusDenied    = "denied"
	authStatusConsumed  = "consumed"
	authStatusExpired   = "expired"
	authStatusConnected = "connected"

	codeAuthUnsupported   = "auth_unsupported"
	codeAuthNotRequired   = "auth_not_required"
	codeRequestUnknown    = "request_unknown"
	codeSecretWriteFailed = "secret_write_failed"
	codeLoginRequired     = "login_required"

	messageAuthUnsupported = "这个商城版本不支持登录授权；安装会按匿名模式继续。"
	messageAuthNotRequired = "这个商城当前不要求登录，不需要连接。"
	messageRequestUnknown  = "这次授权请求已经不在本进程里（插件可能重启过），请重新点「连接商城」。"
	messageSecretWriteFail = "商城已经授权，但把令牌写入宿主设置失败。请重试；如果一直失败，请检查 SForum 版本是否支持写入 secret 设置。"
	messageLoginRequired   = "需要先连接商城：请在商城页面点「连接商城」完成授权。"
)

const (
	// 与商城契约一致：verifier 43..128 字符，S256 challenge 固定 43 字符。
	authVerifierBytes   = 32
	authPendingTTL      = 10 * time.Minute
	authPendingMaxItems = 32
	authModeTTL         = 60 * time.Second
	// 令牌是 sfo_ + 43 字符。
	authTokenLength = 47
)

var errSecretUnavailable = errors.New("host secret service is unavailable")

// secretStore 是宿主 SecretService 的测试缝：生产恒为 nil（见 writeAccountSecret）。
type secretStore interface {
	put(ctx context.Context, credential accountCredential) error
	clear(ctx context.Context) error
}

// authAccount 是商城账号在插件侧的投影：只用于显示「已连接为 @x」，
// 不参与任何授权判断（真正的判断在商城）。
type authAccount struct {
	ID          string `json:"id"`
	IssuerKey   string `json:"issuerKey"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	AvatarURL   string `json:"avatarUrl"`
}

// accountCredential 是 secret 设置里的 JSON。它整体加密存放，
// 设置页只显示「已配置」，不回显任何字段。
type accountCredential struct {
	Token     string      `json:"token"`
	ExpiresAt string      `json:"expiresAt"`
	Account   authAccount `json:"account"`
}

// documentValue 把账号投影成可编码进 TypedDocument 的 map：
// structpb 不接受 Go 结构体，路由响应的值只能是 map/slice/标量。
func (a authAccount) documentValue() map[string]any {
	return map[string]any{
		"id":          a.ID,
		"issuerKey":   a.IssuerKey,
		"username":    a.Username,
		"displayName": a.DisplayName,
		"avatarUrl":   a.AvatarURL,
	}
}

func (c accountCredential) expiresAt() (time.Time, bool) {
	parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(c.ExpiresAt))
	if err != nil {
		return time.Time{}, false
	}
	return parsed, true
}

// usable 判断凭据是否还能用：空令牌、无法解析的过期时间、已过期都算未连接。
// 过期后不主动删除——保留能让页面显示「连接已过期」，而不是莫名其妙变回未连接。
func (c accountCredential) usable(now time.Time) bool {
	if strings.TrimSpace(c.Token) == "" {
		return false
	}
	expiry, ok := c.expiresAt()
	if !ok {
		return false
	}
	return expiry.After(now)
}

func parseAccountCredential(raw string) (accountCredential, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return accountCredential{}, false
	}
	var credential accountCredential
	if err := json.Unmarshal([]byte(raw), &credential); err != nil {
		return accountCredential{}, false
	}
	if strings.TrimSpace(credential.Token) == "" {
		return accountCredential{}, false
	}
	return credential, true
}

// authModeCache 缓存商城的模式判断：页面每次挂载都会问一次，
// 60 秒缓存让一次页面加载不会变成两次上游请求。
type authModeCache struct {
	mu        sync.RWMutex
	value     string
	fetchedAt time.Time
}

func (c *authModeCache) get(now time.Time) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.value == "" || now.Sub(c.fetchedAt) >= authModeTTL {
		return "", false
	}
	return c.value, true
}

func (c *authModeCache) set(value string, now time.Time) {
	c.mu.Lock()
	c.value = value
	c.fetchedAt = now
	c.mu.Unlock()
}

func (c *authModeCache) clear() {
	c.mu.Lock()
	c.value = ""
	c.fetchedAt = time.Time{}
	c.mu.Unlock()
}

// pendingAuth 保存一次进行中的授权：verifier 只在这里，兑换成功即删除。
type pendingAuth struct {
	verifier  string
	expiresAt time.Time
}

type pendingAuthStore struct {
	mu    sync.Mutex
	items map[string]pendingAuth
}

func newPendingAuthStore() *pendingAuthStore {
	return &pendingAuthStore{items: make(map[string]pendingAuth)}
}

func (p *pendingAuthStore) put(id, verifier string, expiresAt time.Time, now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.items == nil {
		p.items = make(map[string]pendingAuth)
	}
	// 先清过期项；仍然满就丢最早过期的一条，避免管理员反复点「连接」把内存撑大。
	for key, item := range p.items {
		if !item.expiresAt.After(now) {
			delete(p.items, key)
		}
	}
	if len(p.items) >= authPendingMaxItems {
		oldestKey, oldest := "", time.Time{}
		for key, item := range p.items {
			if oldestKey == "" || item.expiresAt.Before(oldest) {
				oldestKey, oldest = key, item.expiresAt
			}
		}
		delete(p.items, oldestKey)
	}
	p.items[id] = pendingAuth{verifier: verifier, expiresAt: expiresAt}
}

func (p *pendingAuthStore) take(id string, now time.Time) (pendingAuth, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	item, ok := p.items[id]
	if !ok {
		return pendingAuth{}, false
	}
	if !item.expiresAt.After(now) {
		delete(p.items, id)
		return pendingAuth{}, false
	}
	return item, true
}

func (p *pendingAuthStore) drop(id string) {
	p.mu.Lock()
	delete(p.items, id)
	p.mu.Unlock()
}

// newCodeVerifier / challengeFor 是 PKCE 的两半（RFC 7636 S256）。
func newCodeVerifier() (string, error) {
	buffer := make([]byte, authVerifierBytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func challengeFor(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// authMode 返回商城当前的模式。旧商城（404）折叠成 unsupported：
// 页面据此隐藏连接 UI，而不是显示一个永远失败的按钮。
// authMode 返回商城当前的模式。
//
// 三种结果必须分开，否则页面会说谎：
//   - 拿到模式 → 原样返回；
//   - 404 → `unsupported`（旧商城，不会改变，缓存它）；
//   - 其它失败（传输、超时、5xx、形状不符）→ **不返回 unsupported**，把错误往上抛，
//     由调用方按 upstream_error 处理。把「商城抖了一下」说成「这个商城版本不支持登录授权」
//     会让操作者以为功能不存在，从而根本不去重试。
func (s *storeServer) authMode(ctx context.Context, settings storeSettings) (string, error) {
	now := time.Now()
	if cached, ok := s.authModeCache.get(now); ok {
		return cached, nil
	}
	mode, err := s.store.authMode(ctx, settings.CatalogBaseURL)
	if err != nil {
		if errors.Is(err, errUpstreamNotFound) {
			// 旧商城不会改变，缓存它；否则每次页面加载都多一次 404。
			s.authModeCache.set(authModeUnsupported, now)
			return authModeUnsupported, nil
		}
		return "", err
	}
	s.authModeCache.set(mode.Mode, now)
	return mode.Mode, nil
}

// credential 读出当前凭据（不校验是否过期）。
func (s *storeServer) credential(ctx context.Context, routeCtx *protocolwire.RequestContext) (accountCredential, bool) {
	settings := s.settings(ctx, routeCtx)
	return parseAccountCredential(settings.AccountToken)
}

func (s *storeServer) handleAuthStatus(ctx context.Context, request *pluginwire.RouteRequest) (*pluginwire.RouteResponse, error) {
	settings := s.settings(ctx, request.GetContext())
	if !settings.configured() {
		return errorResponse(request.GetContext(), schemaAuthStatusResponse, http.StatusServiceUnavailable, codeNotConfigured, messageNotConfigured)
	}

	mode, err := s.authMode(ctx, settings)
	if err != nil {
		return failureResponse(request.GetContext(), routeAuthStatusID, authFailure(err), err)
	}
	credential, connected := parseAccountCredential(settings.AccountToken)
	now := time.Now()
	connected = connected && credential.usable(now)

	values := map[string]any{
		"mode":      mode,
		"connected": connected,
		"account":   nil,
		"expiresAt": nil,
	}
	if connected {
		values["account"] = credential.Account.documentValue()
		if expiry, ok := credential.expiresAt(); ok {
			values["expiresAt"] = expiry.UTC().Format(time.RFC3339)
		}
	}
	return routeDocument(request.GetContext(), http.StatusOK, schemaAuthStatusResponse, values)
}

func (s *storeServer) handleAuthStart(ctx context.Context, request *pluginwire.RouteRequest) (*pluginwire.RouteResponse, error) {
	settings := s.settings(ctx, request.GetContext())
	if !settings.configured() {
		return errorResponse(request.GetContext(), schemaAuthStartResponse, http.StatusServiceUnavailable, codeNotConfigured, messageNotConfigured)
	}
	mode, err := s.authMode(ctx, settings)
	if err != nil {
		return failureResponse(request.GetContext(), routeAuthStartID, authFailure(err), err)
	}
	switch mode {
	case authModeUnsupported:
		return errorResponse(request.GetContext(), schemaAuthStartResponse, http.StatusServiceUnavailable, codeAuthUnsupported, messageAuthUnsupported)
	case authModeAnonymous:
		// 匿名模式下连接没有意义；页面本不该显示入口，直接说清楚比 500 好。
		return errorResponse(request.GetContext(), schemaAuthStartResponse, http.StatusConflict, codeAuthNotRequired, messageAuthNotRequired)
	}

	verifier, err := newCodeVerifier()
	if err != nil {
		return errorResponse(request.GetContext(), schemaAuthStartResponse, http.StatusInternalServerError, codeUpstreamError, messageUpstreamError)
	}
	created, err := s.store.createAuthRequest(ctx, settings.CatalogBaseURL, challengeFor(verifier), s.clientLabel())
	if err != nil {
		return failureResponse(request.GetContext(), routeAuthStartID, authFailure(err), err)
	}
	// authorize_url 必须落在配置的商城地址上：否则页面会把管理员送去别的主机，
	// 而那个主机可以拿着请求 id 骗他批准。
	if !sameOrigin(settings.CatalogBaseURL, created.AuthorizeURL) {
		return errorResponse(request.GetContext(), schemaAuthStartResponse, http.StatusBadGateway, codeUpstreamError, messageUpstreamError)
	}

	now := time.Now()
	expiresIn := created.ExpiresIn
	if expiresIn <= 0 {
		expiresIn = int(authPendingTTL / time.Second)
	}
	s.pending.put(created.ID, verifier, now.Add(time.Duration(expiresIn)*time.Second), now)
	log.Printf("%s: opened request %s", routeAuthStartID, created.ID)

	return routeDocument(request.GetContext(), http.StatusOK, schemaAuthStartResponse, map[string]any{
		"requestId":    created.ID,
		"authorizeUrl": created.AuthorizeURL,
		"expiresIn":    expiresIn,
		"interval":     created.Interval,
	})
}

func (s *storeServer) handleAuthPoll(ctx context.Context, request *pluginwire.RouteRequest) (*pluginwire.RouteResponse, error) {
	settings := s.settings(ctx, request.GetContext())
	if !settings.configured() {
		return errorResponse(request.GetContext(), schemaAuthPollResponse, http.StatusServiceUnavailable, codeNotConfigured, messageNotConfigured)
	}
	requestID, err := authPollRequestFromBody(request)
	if err != nil {
		return errorResponse(request.GetContext(), schemaAuthPollResponse, http.StatusBadRequest, codeInvalidRequest, err.Error())
	}

	now := time.Now()
	pending, ok := s.pending.take(requestID, now)
	if !ok {
		return errorResponse(request.GetContext(), schemaAuthPollResponse, http.StatusNotFound, codeRequestUnknown, messageRequestUnknown)
	}

	status, err := s.store.authRequestStatus(ctx, settings.CatalogBaseURL, requestID)
	if err != nil {
		return failureResponse(request.GetContext(), routeAuthPollID, authFailure(err), err)
	}

	switch status {
	case authStatusPending:
		return authPollDocument(request.GetContext(), map[string]any{"status": authStatusPending, "account": nil, "expiresAt": nil})
	case authStatusDenied:
		s.pending.drop(requestID)
		return authPollDocument(request.GetContext(), map[string]any{"status": authStatusDenied, "account": nil, "expiresAt": nil})
	case authStatusExpired:
		s.pending.drop(requestID)
		return authPollDocument(request.GetContext(), map[string]any{"status": authStatusExpired, "account": nil, "expiresAt": nil})
	case authStatusConsumed:
		// 请求已被兑换过（例如上一次轮询写 secret 失败后重试）：清掉本地状态，
		// 让页面重新发起，而不是一直转圈。
		s.pending.drop(requestID)
		return authPollDocument(request.GetContext(), map[string]any{"status": authStatusConsumed, "account": nil, "expiresAt": nil})
	}

	token, err := s.store.exchangeAuthRequest(ctx, settings.CatalogBaseURL, requestID, pending.verifier)
	if err != nil {
		return failureResponse(request.GetContext(), routeAuthPollID, authFailure(err), err)
	}
	credential := accountCredential{
		Token:     token.AccessToken,
		ExpiresAt: token.ExpiresAt,
		Account: authAccount{
			ID:          token.Account.ID,
			IssuerKey:   token.Account.IssuerKey,
			Username:    token.Account.Username,
			DisplayName: token.Account.DisplayName,
			AvatarURL:   token.Account.AvatarURL,
		},
	}
	if err := s.writeAccountSecret(ctx, request.GetContext(), credential); err != nil {
		// 令牌已经签发但没地方放：尽力撤销，别让一个没人持有的凭据活着。
		_ = s.store.revokeAuthToken(ctx, settings.CatalogBaseURL, credential.Token)
		s.pending.drop(requestID)
		log.Printf("%s: secret write failed (%s)", routeAuthPollID, secretFailureReason(err))
		return errorResponse(request.GetContext(), schemaAuthPollResponse, http.StatusBadGateway, codeSecretWriteFailed, messageSecretWriteFail)
	}
	s.pending.drop(requestID)
	s.invalidateSettings()
	log.Printf("%s: connected account %s", routeAuthPollID, credential.Account.ID)

	return authPollDocument(request.GetContext(), map[string]any{
		"status":    authStatusConnected,
		"account":   credential.Account.documentValue(),
		"expiresAt": token.ExpiresAt,
	})
}

func (s *storeServer) handleAuthDisconnect(ctx context.Context, request *pluginwire.RouteRequest) (*pluginwire.RouteResponse, error) {
	settings := s.settings(ctx, request.GetContext())
	if !settings.configured() {
		return errorResponse(request.GetContext(), schemaAuthDisconnectResponse, http.StatusServiceUnavailable, codeNotConfigured, messageNotConfigured)
	}

	revoked := false
	if credential, ok := parseAccountCredential(settings.AccountToken); ok {
		// 撤销是尽力而为：本地清掉才是断开的语义，商城那边失败只影响它自己的记录。
		if err := s.store.revokeAuthToken(ctx, settings.CatalogBaseURL, credential.Token); err != nil {
			log.Printf("%s: upstream revoke failed (%s)", routeAuthDisconnectID, upstreamFailureReason(err))
		} else {
			revoked = true
		}
	}

	if err := s.clearAccountSecret(ctx, request.GetContext()); err != nil {
		log.Printf("%s: secret clear failed (%s)", routeAuthDisconnectID, secretFailureReason(err))
		return errorResponse(request.GetContext(), schemaAuthDisconnectResponse, http.StatusBadGateway, codeSecretWriteFailed, messageSecretWriteFail)
	}
	s.invalidateSettings()
	log.Printf("%s: disconnected (upstream_revoked=%t)", routeAuthDisconnectID, revoked)

	return routeDocument(request.GetContext(), http.StatusOK, schemaAuthDisconnectResponse, map[string]any{
		"connected": false,
		"revoked":   revoked,
	})
}

func authPollDocument(ctx *protocolwire.RequestContext, values map[string]any) (*pluginwire.RouteResponse, error) {
	return routeDocument(ctx, http.StatusOK, schemaAuthPollResponse, values)
}

// authPollRequestFromBody 只接受 requestId 一个字段：多带的字段直接拒绝，
// 免得调用方以为能指定 verifier 或账号。
func authPollRequestFromBody(request *pluginwire.RouteRequest) (string, error) {
	if request == nil || request.GetBody() == nil {
		return "", errors.New("缺少请求体。")
	}
	values := request.GetBody().GetValue().AsMap()
	for key := range values {
		if key != "requestId" {
			return "", fmt.Errorf("不认识的字段 %q。", key)
		}
	}
	raw, exists := values["requestId"]
	if !exists {
		return "", errors.New("缺少字段 requestId。")
	}
	text, ok := raw.(string)
	if !ok {
		return "", errors.New("requestId 必须是字符串。")
	}
	text = strings.TrimSpace(text)
	// 商城请求 id 是 uuid；这里只做形状校验，合法性由商城判定。
	if len(text) < 8 || len(text) > 64 {
		return "", errors.New("requestId 不合法。")
	}
	return text, nil
}

func authFailure(err error) routeFailure {
	switch {
	case errors.Is(err, errStoreBaseURL):
		return routeFailure{http.StatusServiceUnavailable, codeNotConfigured, messageNotConfigured}
	case errors.Is(err, errUpstreamNotFound):
		return routeFailure{http.StatusServiceUnavailable, codeAuthUnsupported, messageAuthUnsupported}
	case errors.Is(err, errUpstreamUnauthorized):
		// 兑换/轮询阶段遇到 401：商城不认这次请求，重新发起即可。
		return routeFailure{http.StatusBadGateway, codeUpstreamError, messageUpstreamError}
	default:
		return routeFailure{http.StatusBadGateway, codeUpstreamError, messageUpstreamError}
	}
}

// writeAccountSecret 把凭据写进宿主的加密 secret 设置（SecretService.Put）。
// 这是 core 的「写自身声明 secret」能力；旧 core 没有这个方法时握手就失败，
// 页面会看到 host_api_unsupported 级别的错误。
func (s *storeServer) writeAccountSecret(
	ctx context.Context,
	routeCtx *protocolwire.RequestContext,
	credential accountCredential,
) error {
	if s.secretOverride != nil {
		return s.secretOverride.put(ctx, credential)
	}
	host, err := s.Host()
	if err != nil || host == nil || host.Secrets == nil {
		return errSecretUnavailable
	}
	payload, err := json.Marshal(credential)
	if err != nil {
		return err
	}
	callCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	response, err := host.Secrets.Put(callCtx, &hostwire.SecretPutRequest{
		Context:   hostCallContext(routeCtx),
		SecretId:  settingAccountToken,
		Value:     payload,
		MediaType: "application/json",
	})
	if err != nil {
		return err
	}
	if response.GetError() != nil || !response.GetSecretSet() {
		return fmt.Errorf("secret put rejected: %s", response.GetError().GetReason())
	}
	return nil
}

func (s *storeServer) clearAccountSecret(ctx context.Context, routeCtx *protocolwire.RequestContext) error {
	if s.secretOverride != nil {
		return s.secretOverride.clear(ctx)
	}
	host, err := s.Host()
	if err != nil || host == nil || host.Secrets == nil {
		return errSecretUnavailable
	}
	callCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	response, err := host.Secrets.Clear(callCtx, &hostwire.SecretClearRequest{
		Context:  hostCallContext(routeCtx),
		SecretId: settingAccountToken,
	})
	if err != nil {
		return err
	}
	if response.GetError() != nil {
		return fmt.Errorf("secret clear rejected: %s", response.GetError().GetReason())
	}
	return nil
}

// secretFailureReason 只写错误类别：宿主错误里可能带 settings key，
// 但绝不带值；这里再收敛一次，日志里连 key 都不出现。
func secretFailureReason(err error) string {
	if errors.Is(err, errSecretUnavailable) {
		return "host_secret_unavailable"
	}
	return "host_secret_write_failed"
}

// clientLabel 是授权页上给管理员看的来源名。只用宿主自报的版本号，
// 不含任何用户输入；超长时截断，商城侧还有 64 字符上限。
func (s *storeServer) clientLabel() string {
	build := s.hostBuildSnapshot()
	if version := strings.TrimSpace(build.CoreVersion); version != "" {
		label := "SForum " + version
		if len(label) > 64 {
			return label[:64]
		}
		return label
	}
	return "SForum"
}

func sameOrigin(base, candidate string) bool {
	baseURL, err := url.Parse(strings.TrimRight(strings.TrimSpace(base), "/"))
	if err != nil || baseURL.Host == "" {
		return false
	}
	target, err := url.Parse(strings.TrimSpace(candidate))
	if err != nil || target.Host == "" {
		return false
	}
	return strings.EqualFold(baseURL.Scheme, target.Scheme) && strings.EqualFold(baseURL.Host, target.Host)
}
