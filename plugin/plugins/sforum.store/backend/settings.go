package main

import (
	"context"
	"net/url"
	"strings"
	"sync"
	"time"

	hostwire "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2/gen/sforum/host/v2"
	pluginwire "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2/gen/sforum/plugin/v2"
	protocolwire "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2/gen/sforum/protocol/v2"
	"google.golang.org/protobuf/proto"
)

// Host 的 own-settings 查询（与 sforum-oauth2-provider 用的是同一个契约）。
const (
	hostQueryOwnSettingsID      = "sforum.extensions.settings.own"
	hostQueryOwnSettingsPlan    = "1"
	hostQueryOwnSettingsResult  = "sforum.extensions.settings.own.result"
	hostQueryOwnSettingsVersion = "1"

	settingCatalogBaseURL = "sforum.store.catalog_base_url"
	settingChannel        = "sforum.store.channel"
	// settingAccountToken 是商城授权后由插件自己写入的 secret 设置
	// （manifest/settings.json 里声明 type: secret）。内容见 accountCredential。
	settingAccountToken = "sforum.store.account_token"
)

type storeSettings struct {
	// CatalogBaseURL 为空表示运营还没配置商城地址；此时页面只显示配置提示。
	CatalogBaseURL string
	Channel        string
	// AccountToken 是商城账号凭据的 JSON（accountCredential），空表示未连接。
	// 宿主 own-settings 查询返回的是解密后的明文，所以这里能直接解析。
	AccountToken string
}

func defaultSettings() storeSettings {
	return storeSettings{Channel: "stable"}
}

func (s storeSettings) configured() bool {
	return s.CatalogBaseURL != ""
}

type settingsCache struct {
	mu        sync.RWMutex
	value     storeSettings
	fetchedAt time.Time
}

const settingsTTL = 60 * time.Second

// settings 返回缓存值；过期或未加载时通过 Host 查询一次。读失败沿用旧值，
// 让一次 Host 抖动不至于把整页打成错误。
//
// 单测注入 settingsOverride 时直接返回它：Host 通道未握手时也不要缓存/重试。
func (s *storeServer) settings(ctx context.Context, routeCtx *protocolwire.RequestContext) storeSettings {
	if s.settingsOverride != nil {
		return *s.settingsOverride
	}
	s.settingsCache.mu.RLock()
	cached := s.settingsCache.value
	fetchedAt := s.settingsCache.fetchedAt
	s.settingsCache.mu.RUnlock()
	if !fetchedAt.IsZero() && time.Since(fetchedAt) < settingsTTL {
		return cached
	}

	loaded, ok := s.loadSettings(ctx, routeCtx)
	if !ok {
		if !fetchedAt.IsZero() {
			return cached
		}
		return defaultSettings()
	}

	s.settingsCache.mu.Lock()
	s.settingsCache.value = loaded
	s.settingsCache.fetchedAt = time.Now()
	s.settingsCache.mu.Unlock()
	return loaded
}

func (s *storeServer) loadSettings(ctx context.Context, routeCtx *protocolwire.RequestContext) (storeSettings, bool) {
	result := defaultSettings()
	if routeCtx == nil {
		return result, false
	}
	host, err := s.Host()
	if err != nil || host == nil || host.Queries == nil {
		return result, false
	}

	timeoutCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	response, err := host.Queries.Execute(timeoutCtx, &hostwire.QueryRequest{
		Context:             hostCallContext(routeCtx),
		QueryId:             hostQueryOwnSettingsID,
		PlanVersion:         hostQueryOwnSettingsPlan,
		ResultSchemaId:      hostQueryOwnSettingsResult,
		ResultSchemaVersion: hostQueryOwnSettingsVersion,
		Fields:              []string{settingCatalogBaseURL, settingChannel, settingAccountToken},
	})
	if err != nil || response == nil || response.GetError() != nil || len(response.GetRows()) == 0 {
		return result, false
	}
	values := response.GetRows()[0].GetValue().AsMap()
	container, _ := values["settings"].(map[string]any)
	if container == nil {
		return result, false
	}

	base := strings.TrimRight(strings.TrimSpace(stringValue(container[settingCatalogBaseURL])), "/")
	if parsed, err := url.Parse(base); err == nil && parsed.Scheme == "https" && parsed.Host != "" {
		result.CatalogBaseURL = base
	}
	if channel := strings.TrimSpace(stringValue(container[settingChannel])); channel == "beta" || channel == "stable" {
		result.Channel = channel
	}
	result.AccountToken = strings.TrimSpace(stringValue(container[settingAccountToken]))
	return result, true
}

// invalidateSettings 在写入或清除 secret 之后调用：下一次读取必须回 Host 取，
// 否则页面会在 60 秒缓存里继续显示「未连接」。
func (s *storeServer) invalidateSettings() {
	s.settingsCache.mu.Lock()
	s.settingsCache.fetchedAt = time.Time{}
	s.settingsCache.mu.Unlock()
}

// hostCallContext 构造插件 → Host 调用上下文：Actor 必须清空，否则宿主以
// "protocol v2 actor context is not host-attested" 拒绝。
func hostCallContext(routeCtx *protocolwire.RequestContext) *protocolwire.RequestContext {
	if routeCtx == nil {
		return nil
	}
	clone := proto.Clone(routeCtx).(*protocolwire.RequestContext)
	clone.Actor = nil
	return clone
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

var _ = pluginwire.RouteRequest{}
