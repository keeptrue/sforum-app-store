package main

import (
	"context"
	"time"

	pluginv2 "github.com/zhuchunshu/sforum/apps/api/sdk/plugin/v2"
	pluginwire "github.com/zhuchunshu/sforum/apps/api/sdk/plugin/v2/gen/sforum/plugin/v2"
	protocolwire "github.com/zhuchunshu/sforum/apps/api/sdk/plugin/v2/gen/sforum/protocol/v2"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// 路由与 schema 的 id@version 必须与 sforum.extension.json 完全一致：
// 宿主按 identity 绑定分发，改名会在握手前就被拒。
const (
	routeCatalogID    = "sforum.store.route.catalog"
	routeProductID    = "sforum.store.route.product"
	routeInstallURLID = "sforum.store.route.install-url"

	schemaCatalogResponse    = "sforum.store.catalog.response@1"
	schemaProductResponse    = "sforum.store.product.response@1"
	schemaInstallURLRequest  = "sforum.store.install-url.request@1"
	schemaInstallURLResponse = "sforum.store.install-url.response@1"
	schemaErrorResponse      = "sforum.store.error@1"
)

// storeServer 只承接路由分发；业务在 handlers.go，上游访问在 upstream.go。
type storeServer struct {
	*pluginv2.Server

	store         *storeClient
	settingsCache settingsCache

	// settingsOverride 只给测试用：生产恒为 nil，设置一律来自 Host 的
	// own-settings 查询（settings.go）。测试不启动 go-plugin 运行时，
	// 因此没有已握手的 Host 可读。
	settingsOverride *storeSettings
}

func newStoreServer() (*storeServer, error) {
	server := &storeServer{
		Server: pluginv2.NewServer(),
		store:  newStoreClient(),
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
