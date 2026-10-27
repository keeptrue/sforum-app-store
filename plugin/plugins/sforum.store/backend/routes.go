package main

import (
	"context"
	"sync"
	"time"

	pluginv2 "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2"
	pluginwire "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2/gen/sforum/plugin/v2"
	protocolwire "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2/gen/sforum/protocol/v2"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// 路由与 schema 的 id@version 必须与 sforum.extension.json 完全一致：
// 宿主按 identity 绑定分发，改名会在握手前就被拒。
const (
	routeCatalogID    = "sforum.store.route.catalog"
	routeProductID    = "sforum.store.route.product"
	routeInstallURLID = "sforum.store.route.install-url"
	// 连接商城的四条路由：状态、发起、轮询、断开。
	routeAuthStatusID     = "sforum.store.route.auth-status"
	routeAuthStartID      = "sforum.store.route.auth-start"
	routeAuthPollID       = "sforum.store.route.auth-poll"
	routeAuthDisconnectID = "sforum.store.route.auth-disconnect"

	schemaCatalogResponse    = "sforum.store.catalog.response@1"
	schemaProductResponse    = "sforum.store.product.response@1"
	schemaInstallURLRequest  = "sforum.store.install-url.request@1"
	schemaInstallURLResponse = "sforum.store.install-url.response@1"
	schemaErrorResponse      = "sforum.store.error@1"

	schemaAuthStatusResponse     = "sforum.store.auth-status.response@1"
	schemaAuthStartResponse      = "sforum.store.auth-start.response@1"
	schemaAuthPollRequest        = "sforum.store.auth-poll.request@1"
	schemaAuthPollResponse       = "sforum.store.auth-poll.response@1"
	schemaAuthDisconnectResponse = "sforum.store.auth-disconnect.response@1"
)

// storeServer 只承接路由分发；业务在 handlers.go，上游访问在 upstream.go，
// 宿主已装清单在 inventory.go。
type storeServer struct {
	*pluginv2.Server

	store          *storeClient
	settingsCache  settingsCache
	inventoryCache inventoryCache

	// 连接商城的进程内状态：商城模式（60 秒缓存）与进行中的授权（verifier 只在这里）。
	authModeCache authModeCache
	pending       *pendingAuthStore

	// settingsOverride 只给测试用：生产恒为 nil，设置一律来自 Host 的
	// own-settings 查询（settings.go）。测试不启动 go-plugin 运行时，
	// 因此没有已握手的 Host 可读。
	settingsOverride *storeSettings

	// secretOverride 只给测试用：生产恒为 nil，凭据一律写宿主的 SecretService
	// （auth.go）。测试不启动 go-plugin 运行时，没有可用的 Host 通道。
	secretOverride secretStore

	// hostBuildOverride / inventoryFetch 也只给测试用：生产恒为 nil。
	// 宿主版本来自 v2 握手快照（upstream.go），已装清单来自 Host Query
	// （inventory.go），两者都需要真实的宿主运行时。
	hostBuildOverride *hostBuild
	inventoryFetch    inventoryPageFetcher

	// 握手时冻结的宿主版本只读一次：进程生命周期内不可能变化。
	hostBuildOnce  sync.Once
	hostBuildValue hostBuild
}

func newStoreServer() (*storeServer, error) {
	server := &storeServer{
		Server:  pluginv2.NewServer(),
		store:   newStoreClient(),
		pending: newPendingAuthStore(),
	}
	return server, nil
}

// InvokeRoute 是 HTTP 模式路由的唯一入口：宿主已经做完 guard 与 CSRF，
// 这里只按 route id 分流，并把结果编码成绑定 schema 的文档。
func (s *storeServer) InvokeRoute(ctx context.Context, request *pluginwire.RouteRequest) (*pluginwire.RouteResponse, error) {
	switch request.GetRouteId() {
	case routeCatalogID:
		return s.handleCatalog(ctx, request)
	case routeProductID:
		return s.handleProduct(ctx, request)
	case routeInstallURLID:
		return s.handleInstallURL(ctx, request)
	case routeAuthStatusID:
		return s.handleAuthStatus(ctx, request)
	case routeAuthStartID:
		return s.handleAuthStart(ctx, request)
	case routeAuthPollID:
		return s.handleAuthPoll(ctx, request)
	case routeAuthDisconnectID:
		return s.handleAuthDisconnect(ctx, request)
	default:
		return errorResponse(request.GetContext(), schemaErrorResponse, 404, "route_not_found", "unknown sforum.store route")
	}
}

func newDocument(schemaRef string, values map[string]any) (*protocolwire.TypedDocument, error) {
	return pluginv2.NewTypedDocument(schemaRef, values)
}

var jsonResponseHeaders = map[string]string{"Content-Type": "application/json"}

func routeHeaders(values map[string]string) []*protocolwire.Header {
	result := make([]*protocolwire.Header, 0, len(values))
	for name, value := range values {
		result = append(result, &protocolwire.Header{Name: name, Values: []string{value}})
	}
	return result
}

func routeDocument(ctx *protocolwire.RequestContext, status int, schemaRef string, values map[string]any) (*pluginwire.RouteResponse, error) {
	document, err := newDocument(schemaRef, values)
	if err != nil {
		return nil, err
	}
	return &pluginwire.RouteResponse{
		Context:    responseContext(ctx),
		StatusCode: uint32(status),
		Headers:    routeHeaders(jsonResponseHeaders),
		Body:       document,
	}, nil
}

// responseSchemaForRoute 把路由 id 映射到它自己的响应 schema。
// 宿主会逐字比较响应文档的 schema id 与路由声明的 responseSchema，
// 所以错误文档也必须绑在「本路由」的 schema 上（schema 里同时含成功与错误变体）。
func responseSchemaForRoute(routeID string) string {
	switch routeID {
	case routeCatalogID:
		return schemaCatalogResponse
	case routeProductID:
		return schemaProductResponse
	case routeInstallURLID:
		return schemaInstallURLResponse
	case routeAuthStatusID:
		return schemaAuthStatusResponse
	case routeAuthStartID:
		return schemaAuthStartResponse
	case routeAuthPollID:
		return schemaAuthPollResponse
	case routeAuthDisconnectID:
		return schemaAuthDisconnectResponse
	default:
		return schemaErrorResponse
	}
}

func errorResponse(ctx *protocolwire.RequestContext, schemaRef string, status int, code, message string) (*pluginwire.RouteResponse, error) {
	return routeDocument(ctx, status, schemaRef, map[string]any{
		"code":    code,
		"message": message,
	})
}

func responseContext(request *protocolwire.RequestContext) *protocolwire.ResponseContext {
	result := &protocolwire.ResponseContext{ServerTime: timestamppb.New(time.Now().UTC())}
	if request == nil {
		return result
	}
	result.RequestId = request.GetRequestId()
	if request.GetTrace() != nil {
		result.Trace = proto.Clone(request.GetTrace()).(*protocolwire.TraceContext)
	}
	if request.GetExtension() != nil {
		result.Extension = proto.Clone(request.GetExtension()).(*protocolwire.ExtensionIdentity)
	}
	return result
}
