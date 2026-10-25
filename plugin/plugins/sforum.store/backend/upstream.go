package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 上游访问的全部硬性约束集中在这一点：只有一个 http.Client、10 秒超时、
// 响应体 ≤ 4 MiB、基址必须是配置里的 https 地址。
const (
	upstreamTimeout      = 10 * time.Second
	upstreamMaxBodyBytes = 4 << 20
	upstreamJSONMedia    = "application/json"

	// 缓存只有目录与详情两条读路径；TTL 与 stale 窗口见 §6.4。
	cacheFreshTTL   = 10 * time.Minute
	cacheStaleTTL   = 24 * time.Hour
	cacheMaxEntries = 256

	catalogDefaultLimit = 18
	catalogMaxLimit     = 100
)

const (
	upstreamCatalogPath  = "/api/v1/catalog"
	upstreamProductsPath = "/api/v1/products/"
	upstreamDownloadURLs = "/api/v1/download-urls"
)

// 上游失败分三类，处理方式不同：
//   - errUpstreamNotFound / errUpstreamRejected：上游给了确定性答案，按路由映射成 404；
//   - errUpstreamFailure：传输、超时、5xx、解码或超限，可以用 stale 缓存兜底；
//   - errStoreBaseURL：设置里没有可用的商城地址，请求根本没有发出。
var (
	errStoreBaseURL     = errors.New("store base url is not configured")
	errUpstreamNotFound = errors.New("upstream resource not found")
	errUpstreamRejected = errors.New("upstream rejected the request")
	errUpstreamFailure  = errors.New("upstream request failed")
)

// upstreamError 只携带短 reason，不带 URL、body 或 header：
// 这样日志里永远不会出现配置值或签名链接。
type upstreamError struct {
	category error
	kind     string
	status   int
}

func (e *upstreamError) Error() string {
	reason := e.kind
	if e.status > 0 {
		reason = fmt.Sprintf("%s_%d", e.kind, e.status)
	}
	if e.category == nil {
		return "upstream " + reason
	}
	return fmt.Sprintf("%v (%s)", e.category, reason)
}

func (e *upstreamError) Unwrap() error { return e.category }

// upstreamFailureReason 是日志里唯一允许出现的原因串。
func upstreamFailureReason(err error) string {
	var failure *upstreamError
	if errors.As(err, &failure) {
		if failure.status > 0 {
			return fmt.Sprintf("%s_%d", failure.kind, failure.status)
		}
		return failure.kind
	}
	if errors.Is(err, errStoreBaseURL) {
		return "base_url"
	}
	return "unknown"
}

// storeClient 负责访问商城 HTTP API，并按「完整上游路径 + 查询」缓存 ETag 读结果。
// 只缓存成功的目录/详情读取；install-url 永远不缓存，签名链接不落任何内存。
type storeClient struct {
	http       *http.Client
	freshTTL   time.Duration
	staleTTL   time.Duration
	maxEntries int
	now        func() time.Time

	mu      sync.Mutex
	entries map[string]*cacheEntry
}

type cacheEntry struct {
	etag      string
	payload   any // *upstreamCatalog 或 *upstreamProduct（解码后的 DTO）
	fetchedAt time.Time
}

// catalogResult / productResult 携带缓存新鲜度，handler 据此写 stale 与 fetchedAt。
type catalogResult struct {
	page      *upstreamCatalog
	fetchedAt time.Time
	stale     bool
}

type productResult struct {
	product   *upstreamProduct
	fetchedAt time.Time
	stale     bool
}

func newStoreClient() *storeClient {
	return &storeClient{
		http:       newStoreHTTPClient(),
		freshTTL:   cacheFreshTTL,
		staleTTL:   cacheStaleTTL,
		maxEntries: cacheMaxEntries,
		now:        time.Now,
		entries:    make(map[string]*cacheEntry),
	}
}

// newStoreHTTPClient 是唯一的出站客户端：固定超时，且不跟随重定向
// （配置里的基址就是唯一目的地，3xx 一律按上游失败处理）。
func newStoreHTTPClient() *http.Client {
	return &http.Client{
		Timeout: upstreamTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// catalogQuery 是转发给商城的过滤条件。os/arch 恒取本进程的
// runtime.GOOS/GOARCH：安装对象是服务器，不是管理员浏览器。
type catalogQuery struct {
	Channel  string
	Q        string
	Category string
	Cursor   string
	Limit    int
	// SForum / SForumBuild 是宿主在 v2 握手时冻结的 CoreVersion / BuildVersion。
	// 未知（旧宿主没给 host_build）时两者都是空串：那两个参数根本不发出去，
	// 上游据此保持 compatibility=unknown，插件也不替宿主猜一个版本。
	SForum      string
	SForumBuild string
	// Compat 是兼容过滤强度（compatible / all）。上游只在拿到宿主版本时才真的
	// 过滤，所以版本未知时发它不改变结果，也不会误删条目。
	Compat string
}

// hostBuild 是宿主在 protocol v2 握手时冻结的构建身份（SDK: Server.HostBuild）。
// CoreVersion 是兼容判定的唯一权威，BuildVersion 只用来识别 dev 构建；两者都为空
// 表示宿主没给，调用方必须按 unknown 处理，不得补一个默认版本。
type hostBuild struct {
	CoreVersion  string
	BuildVersion string
}

// hostBuildSnapshot 返回进程内唯一的宿主版本快照：SDK 保证握手后该值不再变化，
// 所以只读一次。ok=false（旧宿主没有 host_build 字段）时返回零值，调用方因此不
// 发送 sforum/sforumBuild。测试注入 hostBuildOverride 时直接返回它：测试不启动
// go-plugin 运行时，没有已握手的 Host 可读。
func (s *storeServer) hostBuildSnapshot() hostBuild {
	if s.hostBuildOverride != nil {
		return *s.hostBuildOverride
	}
	s.hostBuildOnce.Do(func() {
		if s.Server == nil {
			return
		}
		build, ok := s.HostBuild()
		if !ok {
			return
		}
		s.hostBuildValue = hostBuild{
			CoreVersion:  strings.TrimSpace(build.CoreVersion),
			BuildVersion: strings.TrimSpace(build.BuildVersion),
		}
	})
	return s.hostBuildValue
}

// setHostVersion 只写非空的版本参数：空串是「宿主没给」，不能变成 sforum=。
func setHostVersion(values url.Values, build hostBuild) {
	if build.CoreVersion != "" {
		values.Set("sforum", build.CoreVersion)
	}
	if build.BuildVersion != "" {
		values.Set("sforumBuild", build.BuildVersion)
	}
}

func (q catalogQuery) values() url.Values {
	values := url.Values{}
	values.Set("channel", q.Channel)
	values.Set("limit", strconv.Itoa(q.Limit))
	values.Set("os", runtime.GOOS)
	values.Set("arch", runtime.GOARCH)
	if q.Q != "" {
		values.Set("q", q.Q)
	}
	if q.Category != "" {
		values.Set("category", q.Category)
	}
	if q.Cursor != "" {
		values.Set("cursor", q.Cursor)
	}
	setHostVersion(values, hostBuild{CoreVersion: q.SForum, BuildVersion: q.SForumBuild})
	if q.Compat != "" {
		values.Set("compat", q.Compat)
	}
	return values
}

// baseEndpoint 校验并拼接上游地址。base 来自 Host 设置，settings.go 已经要求
// https + host；这里再验一次，防止任何调用路径绕过那层校验。
func baseEndpoint(base, path string, query url.Values) (string, error) {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		return "", errStoreBaseURL
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errStoreBaseURL
	}
	endpoint := base + path
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	return endpoint, nil
}

func (c *storeClient) catalog(ctx context.Context, base string, query catalogQuery) (catalogResult, error) {
	endpoint, err := baseEndpoint(base, upstreamCatalogPath, query.values())
	if err != nil {
		return catalogResult{}, err
	}
	page, fetchedAt, stale, err := cachedJSON[upstreamCatalog](c, ctx, endpoint)
	if err != nil {
		return catalogResult{}, err
	}
	if page == nil {
		return catalogResult{}, &upstreamError{category: errUpstreamFailure, kind: "empty_document"}
	}
	return catalogResult{page: page, fetchedAt: fetchedAt, stale: stale}, nil
}

// product 读产品详情。sforum/sforumBuild 与目录查询同源：宿主给了就带上，让上游
// 按同一份版本面求值每个 release 的约束。
func (c *storeClient) product(ctx context.Context, base, slug string, build hostBuild) (productResult, error) {
	query := url.Values{}
	setHostVersion(query, build)
	endpoint, err := baseEndpoint(base, upstreamProductsPath+url.PathEscape(slug), query)
	if err != nil {
		return productResult{}, err
	}
	product, fetchedAt, stale, err := cachedJSON[upstreamProduct](c, ctx, endpoint)
	if err != nil {
		return productResult{}, err
	}
	if product == nil {
		return productResult{}, &upstreamError{category: errUpstreamFailure, kind: "empty_document"}
	}
	return productResult{product: product, fetchedAt: fetchedAt, stale: stale}, nil
}

// cachedJSON 按完整上游路径缓存解码后的文档：
//   - freshTTL 内直接服务内存值；
//   - 过期后带 If-None-Match 复验，304 只刷新 fetchedAt；
//   - 上游故障（传输/超时/5xx/解码）用 staleTTL 内的旧值兜底（stale=true），
//     超出 stale 窗口才把错误抛给 handler。
func cachedJSON[T any](c *storeClient, ctx context.Context, endpoint string) (*T, time.Time, bool, error) {
	now := c.now()

	c.mu.Lock()
	entry := c.entries[endpoint]
	c.mu.Unlock()

	var cached *T
	if entry != nil {
		if payload, ok := entry.payload.(*T); ok {
			cached = payload
		}
	}
	if cached != nil && now.Sub(entry.fetchedAt) < c.freshTTL {
		return cached, entry.fetchedAt, false, nil
	}

	ifNoneMatch := ""
	if cached != nil {
		ifNoneMatch = entry.etag
	}

	value, etag, notModified, err := fetchFresh[T](c, ctx, endpoint, ifNoneMatch)
	if err == nil && notModified {
		if cached != nil {
			fetchedAt := c.now()
			c.store(endpoint, etag, cached, fetchedAt)
			return cached, fetchedAt, false, nil
		}
		err = &upstreamError{category: errUpstreamFailure, kind: "not_modified_without_cache"}
	}
	if err == nil {
		fetchedAt := c.now()
		c.store(endpoint, etag, value, fetchedAt)
		return value, fetchedAt, false, nil
	}
	// 只有「上游故障」能用旧值兜底：404/4xx 是确定性答案，必须如实上报，
	// 否则下架的产品还会被 stale 缓存继续展示。
	if cached != nil && errors.Is(err, errUpstreamFailure) && now.Sub(entry.fetchedAt) <= c.staleTTL {
		return cached, entry.fetchedAt, true, nil
	}
	return nil, time.Time{}, false, err
}

// fetchFresh 发一次条件请求。notModified=true 时 value 为 nil，由调用方复用缓存。
// 写成自由函数而不是方法：go.mod 的语言级版本（go 1.26）不允许泛型方法。
func fetchFresh[T any](
	c *storeClient,
	ctx context.Context,
	endpoint string,
	ifNoneMatch string,
) (*T, string, bool, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, "", false, &upstreamError{category: errUpstreamFailure, kind: "request"}
	}
	request.Header.Set("Accept", upstreamJSONMedia)
	if ifNoneMatch != "" {
		request.Header.Set("If-None-Match", ifNoneMatch)
	}

	response, err := c.http.Do(request)
	if err != nil {
		return nil, "", false, transportFailure(err)
	}
	defer response.Body.Close()

	switch status := response.StatusCode; {
	case status == http.StatusNotModified:
		return nil, ifNoneMatch, true, nil
	case status >= 200 && status < 300:
	default:
		discardBody(response.Body)
		return nil, "", false, statusFailure(status)
	}

	body, err := readLimitedBody(response.Body)
	if err != nil {
		return nil, "", false, err
	}
	var value T
	// DisallowUnknownFields 保持关闭：商城可以在不改契约版本的前提下加字段，
	// 未知字段由 mapping.go 的显式映射丢弃。
	if err := json.Unmarshal(body, &value); err != nil {
		return nil, "", false, &upstreamError{category: errUpstreamFailure, kind: "decode"}
	}
	return &value, strings.TrimSpace(response.Header.Get("ETag")), false, nil
}

// downloadURL 是 install-url 的上游调用，唯一一条不缓存的路径。
// 返回体只保留 url/sha256/size/expiresAt 四个字段，且绝不写日志。
func (c *storeClient) downloadURL(
	ctx context.Context,
	base string,
	payload downloadURLRequest,
) (upstreamDownloadURL, error) {
	endpoint, err := baseEndpoint(base, upstreamDownloadURLs, nil)
	if err != nil {
		return upstreamDownloadURL{}, err
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return upstreamDownloadURL{}, &upstreamError{category: errUpstreamFailure, kind: "encode"}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return upstreamDownloadURL{}, &upstreamError{category: errUpstreamFailure, kind: "request"}
	}
	request.Header.Set("Content-Type", upstreamJSONMedia)
	request.Header.Set("Accept", upstreamJSONMedia)

	response, err := c.http.Do(request)
	if err != nil {
		return upstreamDownloadURL{}, transportFailure(err)
	}
	defer response.Body.Close()

	if status := response.StatusCode; status < 200 || status >= 300 {
		discardBody(response.Body)
		return upstreamDownloadURL{}, statusFailure(status)
	}

	body, err := readLimitedBody(response.Body)
	if err != nil {
		return upstreamDownloadURL{}, err
	}
	var result upstreamDownloadURL
	if err := json.Unmarshal(body, &result); err != nil {
		return upstreamDownloadURL{}, &upstreamError{category: errUpstreamFailure, kind: "decode"}
	}
	if err := result.validate(); err != nil {
		return upstreamDownloadURL{}, err
	}
	return result, nil
}

func (c *storeClient) store(key, etag string, payload any, fetchedAt time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]*cacheEntry)
	}
	if _, exists := c.entries[key]; !exists && len(c.entries) >= c.maxEntries {
		c.evictLocked(fetchedAt)
	}
	c.entries[key] = &cacheEntry{etag: etag, payload: payload, fetchedAt: fetchedAt}
}

// evictLocked 先清理超过 stale 窗口的条目，仍然超限时丢掉最旧的一条，
// 避免调用方用任意 cursor 把缓存撑爆。
func (c *storeClient) evictLocked(now time.Time) {
	for key, entry := range c.entries {
		if now.Sub(entry.fetchedAt) > c.staleTTL {
			delete(c.entries, key)
		}
	}
	if len(c.entries) < c.maxEntries {
		return
	}
	oldestKey := ""
	var oldest time.Time
	for key, entry := range c.entries {
		if oldestKey == "" || entry.fetchedAt.Before(oldest) {
			oldestKey, oldest = key, entry.fetchedAt
		}
	}
	if oldestKey != "" {
		delete(c.entries, oldestKey)
	}
}

func readLimitedBody(body io.Reader) ([]byte, error) {
	payload, err := io.ReadAll(io.LimitReader(body, upstreamMaxBodyBytes+1))
	if err != nil {
		return nil, &upstreamError{category: errUpstreamFailure, kind: "read"}
	}
	if len(payload) > upstreamMaxBodyBytes {
		return nil, &upstreamError{category: errUpstreamFailure, kind: "too_large"}
	}
	return payload, nil
}

func discardBody(body io.Reader) {
	_, _ = io.Copy(io.Discard, io.LimitReader(body, 4<<10))
}

func statusFailure(status int) error {
	switch {
	case status == http.StatusNotFound:
		return &upstreamError{category: errUpstreamNotFound, kind: "http", status: status}
	case status >= 400 && status < 500:
		return &upstreamError{category: errUpstreamRejected, kind: "http", status: status}
	default:
		return &upstreamError{category: errUpstreamFailure, kind: "http", status: status}
	}
}

func transportFailure(err error) error {
	kind := "transport"
	var timeout interface{ Timeout() bool }
	switch {
	case errors.As(err, &timeout) && timeout.Timeout(), errors.Is(err, context.DeadlineExceeded):
		kind = "timeout"
	}
	return &upstreamError{category: errUpstreamFailure, kind: kind}
}
