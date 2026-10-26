package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	pluginwire "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2/gen/sforum/plugin/v2"
	protocolwire "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2/gen/sforum/protocol/v2"
)

// 三个 handler 只做「解码 → 一次上游调用 → 编码」：过滤条件的语义在
// catalogQueryFromRequest / installRequestFromBody，上游访问与缓存在 upstream.go，
// 上游 DTO 到插件 DTO 的映射在 mapping.go。
//
// 对外错误码是页面契约的一部分（not_configured / invalid_request /
// product_not_found / asset_not_found / upstream_error），文案只写本地化提示，
// 不回显上游失败细节。

const (
	codeNotConfigured   = "not_configured"
	codeInvalidRequest  = "invalid_request"
	codeProductNotFound = "product_not_found"
	codeAssetNotFound   = "asset_not_found"
	codeUpstreamError   = "upstream_error"

	messageNotConfigured   = "商城地址未配置：请在扩展设置里填写商城地址（https）后重试。"
	messageProductNotFound = "商城里没有这个产品。"
	messageAssetNotFound   = "这个产品没有匹配当前平台的安装包。"
	messageUpstreamError   = "商城暂时不可用，请稍后再试。"
)

// 目录查询的长度上限与上游契约一致（q 120 字符），超限直接拒，不做静默截断。
const (
	maxSearchLength = 120
	maxFilterLength = 64
	maxCursorLength = 512
)

var (
	// slugPattern 对齐 contracts/store-api.yaml 的 Slug 参数。
	slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,63}$`)
	// platformPattern 用于 os/arch：小写标识符，长度上限 32。
	platformPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)
	// versionPattern 允许 semver 与带 v 前缀的写法，不含路径字符。
	versionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+~-]{0,63}$`)
)

func (s *storeServer) handleCatalog(ctx context.Context, request *pluginwire.RouteRequest) (*pluginwire.RouteResponse, error) {
	settings := s.settings(ctx, request.GetContext())
	if !settings.configured() {
		return errorResponse(request.GetContext(), schemaCatalogResponse, http.StatusServiceUnavailable, codeNotConfigured, messageNotConfigured)
	}

	query, err := catalogQueryFromRequest(request, settings, s.hostBuildSnapshot())
	if err != nil {
		return errorResponse(request.GetContext(), schemaCatalogResponse, http.StatusBadRequest, codeInvalidRequest, err.Error())
	}

	result, err := s.store.catalog(ctx, settings.CatalogBaseURL, query)
	if err != nil {
		return failureResponse(request.GetContext(), routeCatalogID, catalogFailure(err), err)
	}
	if result.stale {
		log.Printf("%s: serving stale catalog fetched at %s", routeCatalogID, fetchedAtString(result.fetchedAt))
	}

	values, dropped := catalogResponseValues(result, settings.CatalogBaseURL, s.installed(ctx, request.GetContext()))
	if dropped > 0 {
		log.Printf("%s: dropped %d catalog items with unexpected shape", routeCatalogID, dropped)
	}
	return routeDocument(request.GetContext(), http.StatusOK, schemaCatalogResponse, values)
}

func (s *storeServer) handleProduct(ctx context.Context, request *pluginwire.RouteRequest) (*pluginwire.RouteResponse, error) {
	settings := s.settings(ctx, request.GetContext())
	if !settings.configured() {
		return errorResponse(request.GetContext(), schemaProductResponse, http.StatusServiceUnavailable, codeNotConfigured, messageNotConfigured)
	}

	slug := strings.TrimSpace(request.GetQueryParameters()["slug"])
	if !slugPattern.MatchString(slug) {
		return errorResponse(request.GetContext(), schemaProductResponse, http.StatusBadRequest, codeInvalidRequest, "slug 缺失或不是合法的产品标识。")
	}

	result, err := s.store.product(ctx, settings.CatalogBaseURL, slug, s.hostBuildSnapshot())
	if err != nil {
		return failureResponse(request.GetContext(), routeProductID, productFailure(err), err)
	}
	if result.stale {
		log.Printf("%s: serving stale product fetched at %s", routeProductID, fetchedAtString(result.fetchedAt))
	}

	values, dropped, err := productResponseValues(result, settings.CatalogBaseURL, s.installed(ctx, request.GetContext()))
	if err != nil {
		return failureResponse(request.GetContext(), routeProductID, productFailure(err), err)
	}
	if dropped > 0 {
		log.Printf("%s: dropped %d releases with unexpected shape", routeProductID, dropped)
	}
	return routeDocument(request.GetContext(), http.StatusOK, schemaProductResponse, values)
}

func (s *storeServer) handleInstallURL(ctx context.Context, request *pluginwire.RouteRequest) (*pluginwire.RouteResponse, error) {
	settings := s.settings(ctx, request.GetContext())
	if !settings.configured() {
		return errorResponse(request.GetContext(), schemaInstallURLResponse, http.StatusServiceUnavailable, codeNotConfigured, messageNotConfigured)
	}

	payload, err := installRequestFromBody(request)
	if err != nil {
		return errorResponse(request.GetContext(), schemaInstallURLResponse, http.StatusBadRequest, codeInvalidRequest, err.Error())
	}

	result, err := s.store.downloadURL(ctx, settings.CatalogBaseURL, payload)
	if err != nil {
		return failureResponse(request.GetContext(), routeInstallURLID, installURLFailure(err), err)
	}
	// 签名链接只出现在响应里：不落缓存、不写日志，也不回显 sha256 之外的任何字段。
	return routeDocument(request.GetContext(), http.StatusOK, schemaInstallURLResponse, downloadURLValues(result))
}

// routeFailure 是一次上游失败在本路由上的对外表达。
type routeFailure struct {
	status  int
	code    string
	message string
}

func catalogFailure(err error) routeFailure {
	if errors.Is(err, errStoreBaseURL) {
		return routeFailure{http.StatusServiceUnavailable, codeNotConfigured, messageNotConfigured}
	}
	// 目录是读接口：上游任何失败都收敛成 502，页面据此展示缓存或重试提示。
	return routeFailure{http.StatusBadGateway, codeUpstreamError, messageUpstreamError}
}

func productFailure(err error) routeFailure {
	if errors.Is(err, errStoreBaseURL) {
		return routeFailure{http.StatusServiceUnavailable, codeNotConfigured, messageNotConfigured}
	}
	if errors.Is(err, errUpstreamNotFound) {
		return routeFailure{http.StatusNotFound, codeProductNotFound, messageProductNotFound}
	}
	return routeFailure{http.StatusBadGateway, codeUpstreamError, messageUpstreamError}
}

func installURLFailure(err error) routeFailure {
	if errors.Is(err, errStoreBaseURL) {
		return routeFailure{http.StatusServiceUnavailable, codeNotConfigured, messageNotConfigured}
	}
	// 商城对不可见产品/版本/平台一律回 404；其余 4xx 是请求本身有问题，
	// 都不该让管理员看到「稍后再试」。
	if errors.Is(err, errUpstreamNotFound) || errors.Is(err, errUpstreamRejected) {
		return routeFailure{http.StatusNotFound, codeAssetNotFound, messageAssetNotFound}
	}
	return routeFailure{http.StatusBadGateway, codeUpstreamError, messageUpstreamError}
}

// failureResponse 是失败路径的唯一出口：日志只有路由 id、错误码与短原因，
// 不含 URL、设置值或 token。
func failureResponse(
	ctx *protocolwire.RequestContext,
	routeID string,
	failure routeFailure,
	err error,
) (*pluginwire.RouteResponse, error) {
	log.Printf("%s: %s (%s)", routeID, failure.code, upstreamFailureReason(err))
	return errorResponse(ctx, responseSchemaForRoute(routeID), failure.status, failure.code, failure.message)
}

// catalogQueryFromRequest 只接受契约里的过滤参数：调用方带来的 os/arch 一律丢弃
// （目标平台是本进程），sforum/sforumBuild 也永远不由调用方决定——版本只来自握手
// 快照 build。channel 缺省时用设置里的默认频道。
func catalogQueryFromRequest(request *pluginwire.RouteRequest, settings storeSettings, build hostBuild) (catalogQuery, error) {
	params := request.GetQueryParameters()

	channel := strings.TrimSpace(params["channel"])
	switch {
	case channel == "":
		channel = settings.Channel
	case validChannel(channel):
	default:
		return catalogQuery{}, errors.New("channel 只能是 stable 或 beta。")
	}
	if !validChannel(channel) {
		channel = channelStable
	}

	compat, err := catalogCompat(params["compat"])
	if err != nil {
		return catalogQuery{}, err
	}

	platformAll, err := catalogPlatform(params["platform"])
	if err != nil {
		return catalogQuery{}, err
	}

	query := catalogQuery{
		Channel:     channel,
		Compat:      compat,
		PlatformAll: platformAll,
		SForum:      build.CoreVersion,
		SForumBuild: build.BuildVersion,
	}

	if query.Q = strings.TrimSpace(params["q"]); utf8.RuneCountInString(query.Q) > maxSearchLength {
		return catalogQuery{}, fmt.Errorf("关键词不能超过 %d 个字符。", maxSearchLength)
	}
	if query.Category = strings.TrimSpace(params["category"]); utf8.RuneCountInString(query.Category) > maxFilterLength {
		return catalogQuery{}, fmt.Errorf("分类不能超过 %d 个字符。", maxFilterLength)
	}
	if query.Cursor = strings.TrimSpace(params["cursor"]); len(query.Cursor) > maxCursorLength {
		return catalogQuery{}, errors.New("cursor 过长。")
	}

	limit, err := catalogLimit(params["limit"])
	if err != nil {
		return catalogQuery{}, err
	}
	query.Limit = limit
	return query, nil
}

// compat 参数与 compatibility.status 共享 compatible 这个字面值，但语义不同：
// 一个是过滤强度，一个是判定结果。
const (
	compatModeCompatible = "compatible"
	compatModeAll        = "all"
)

// catalogCompat 是 compat 参数的唯一入口：只接受契约里的两个显式值，空值表示
// 「不指定」，原样留空 —— 由商城按宿主决定默认口径（开发版默认不过滤，发行版默认
// 只看可安装）。插件确实知道宿主是不是 dev 构建，但口径规则属于商城：中间层补一个
// 默认值会让两边各说各话，页面看到的就不是本次真正生效的过滤强度。
// 非法值直接拒绝，不做静默回退 —— 否则「我要 all」会被偷偷改回 compatible，
// 页面看到的是被过滤过的目录却以为是全量。
func catalogCompat(raw string) (string, error) {
	switch value := strings.TrimSpace(raw); value {
	case "":
		return "", nil
	case compatModeCompatible, compatModeAll:
		return value, nil
	default:
		return "", errors.New("compat 只能是 compatible 或 all。")
	}
}

// platform 参数是「架构维度」的列表口径，与 compat（版本维度）是两个独立轴：
// compat 决定要不要藏掉宿主 coreVersion 装不上的包，platform 决定要不要藏掉
// 当前架构跑不起来的包。两者都不能靠省略互相顶替。
const (
	platformModeStrict = "strict"
	platformModeAll    = "all"
)

// catalogPlatform 只回答一个问题：要不要把架构维度放宽成 all。
//
// 空值与 `strict` 都返回 false —— `platform=strict` 与省略在上游完全等价，所以插件
// 不替调用方多发这个参数（多发只会让 ETag 抖动）。只有显式 `all` 才放宽。
// 非法值直接拒绝，不做静默回退：把「我要看全部」悄悄改回 strict，会让管理员以为
// 开关坏了，而页面看起来一切正常。
func catalogPlatform(raw string) (bool, error) {
	switch value := strings.TrimSpace(raw); value {
	case "", platformModeStrict:
		return false, nil
	case platformModeAll:
		return true, nil
	default:
		return false, errors.New("platform 只能是 strict 或 all。")
	}
}

func catalogLimit(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return catalogDefaultLimit, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, errors.New("limit 必须是整数。")
	}
	if value < 1 || value > catalogMaxLimit {
		return 0, fmt.Errorf("limit 必须在 1 到 %d 之间。", catalogMaxLimit)
	}
	return value, nil
}

// installRequestFromBody 是 install-url 唯一的入参来源。请求体只能描述
// 「要哪个产品的哪个平台的包」——任何字段都不能指定地址，未列出的字段
// （典型是 url）直接拒绝，因此 body 无法把客户端引向别的主机。
func installRequestFromBody(request *pluginwire.RouteRequest) (downloadURLRequest, error) {
	if request == nil || request.GetBody() == nil {
		return downloadURLRequest{}, errors.New("缺少请求体。")
	}
	values := request.GetBody().GetValue().AsMap()
	for key := range values {
		switch key {
		case "slug", "version", "os", "arch":
		default:
			return downloadURLRequest{}, fmt.Errorf("不认识的字段 %q。", key)
		}
	}

	slug, err := requiredString(values, "slug", slugPattern, "slug")
	if err != nil {
		return downloadURLRequest{}, err
	}
	osName, err := requiredString(values, "os", platformPattern, "os")
	if err != nil {
		return downloadURLRequest{}, err
	}
	arch, err := requiredString(values, "arch", platformPattern, "arch")
	if err != nil {
		return downloadURLRequest{}, err
	}

	version := ""
	if raw, exists := values["version"]; exists {
		text, ok := raw.(string)
		if !ok || !versionPattern.MatchString(text) {
			return downloadURLRequest{}, errors.New("version 不是合法的版本号。")
		}
		version = text
	}

	return downloadURLRequest{Product: slug, Version: version, OS: osName, Arch: arch}, nil
}

func requiredString(values map[string]any, key string, pattern *regexp.Regexp, label string) (string, error) {
	raw, exists := values[key]
	if !exists {
		return "", fmt.Errorf("缺少字段 %s。", key)
	}
	text, ok := raw.(string)
	if !ok {
		return "", fmt.Errorf("%s 必须是字符串。", label)
	}
	if !pattern.MatchString(text) {
		return "", fmt.Errorf("%s 不合法。", label)
	}
	return text, nil
}
