package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	pluginv2 "github.com/zhuchunshu/sforum/apps/api/sdk/plugin/v2"
	pluginwire "github.com/zhuchunshu/sforum/apps/api/sdk/plugin/v2/gen/sforum/plugin/v2"
)

// fakeUpstream 是 httptest 的 TLS 假上游：https 基址满足客户端只接受 https 的约束，
// 单测因此完全不需要真实网络或真实 Host。
type fakeUpstream struct {
	server  *httptest.Server
	handler func(w http.ResponseWriter, r *http.Request, call int)

	mu       sync.Mutex
	requests []recordedRequest
}

type recordedRequest struct {
	Method string
	Path   string
	Query  url.Values
	Header http.Header
	Body   []byte
}

func newFakeUpstream(t *testing.T, handler func(w http.ResponseWriter, r *http.Request, call int)) *fakeUpstream {
	t.Helper()
	fake := &fakeUpstream{handler: handler}
	fake.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		fake.mu.Lock()
		fake.requests = append(fake.requests, recordedRequest{
			Method: r.Method, Path: r.URL.Path, Query: r.URL.Query(), Header: r.Header.Clone(), Body: body,
		})
		call := len(fake.requests)
		fake.mu.Unlock()

		if fake.handler == nil {
			http.NotFound(w, r)
			return
		}
		fake.handler(w, r, call)
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func (f *fakeUpstream) baseURL() string { return f.server.URL }

// client 复用 httptest 的自签 CA，但保留生产客户端的超时与不跟随重定向语义。
func (f *fakeUpstream) client(t *testing.T) *http.Client {
	t.Helper()
	client := newStoreHTTPClient()
	client.Transport = f.server.Client().Transport
	return client
}

func (f *fakeUpstream) calls() []recordedRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recordedRequest(nil), f.requests...)
}

func (f *fakeUpstream) last(t *testing.T) recordedRequest {
	t.Helper()
	calls := f.calls()
	if len(calls) == 0 {
		t.Fatalf("upstream received no request")
	}
	return calls[len(calls)-1]
}

func (f *fakeUpstream) hits() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

// newTestStoreServer 构造不依赖 Host 的服务：设置由 settingsOverride 注入，
// 生产路径仍然只读 Host 的 own-settings 查询。
func newTestStoreServer(t *testing.T, settings storeSettings) *storeServer {
	t.Helper()
	return &storeServer{
		Server:           pluginv2.NewServer(),
		store:            newStoreClient(),
		settingsOverride: &settings,
	}
}

func newBoundStoreServer(t *testing.T, fake *fakeUpstream, settings storeSettings) *storeServer {
	t.Helper()
	settings.CatalogBaseURL = fake.baseURL()
	server := newTestStoreServer(t, settings)
	server.store.http = fake.client(t)
	return server
}

func invokeRoute(
	t *testing.T,
	server *storeServer,
	routeID string,
	params map[string]string,
	body map[string]any,
) *pluginwire.RouteResponse {
	t.Helper()
	request := &pluginwire.RouteRequest{RouteId: routeID, QueryParameters: params}
	if body != nil {
		document, err := pluginv2.NewTypedDocument(schemaInstallURLRequest, body)
		if err != nil {
			t.Fatalf("build request document: %v", err)
		}
		request.Body = document
	}
	response, err := server.InvokeRoute(context.Background(), request)
	if err != nil {
		t.Fatalf("invoke %s: %v", routeID, err)
	}
	if response == nil {
		t.Fatalf("invoke %s: nil response", routeID)
	}
	return response
}

func assertJSONDocument(t *testing.T, response *pluginwire.RouteResponse, schemaRef string) map[string]any {
	t.Helper()
	var contentType string
	for _, header := range response.GetHeaders() {
		if header.GetName() == "Content-Type" {
			contentType = strings.Join(header.GetValues(), ",")
		}
	}
	if contentType != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", contentType)
	}
	if response.GetBody() == nil {
		t.Fatalf("response has no body document")
	}
	if !pluginv2.DocumentMatchesSchema(response.GetBody(), schemaRef) {
		t.Fatalf("body schema = %s@%s, want %s",
			response.GetBody().GetSchemaId(), response.GetBody().GetSchemaVersion(), schemaRef)
	}
	return response.GetBody().GetValue().AsMap()
}

func assertStatus(t *testing.T, response *pluginwire.RouteResponse, want int) {
	t.Helper()
	if got := int(response.GetStatusCode()); got != want {
		t.Fatalf("status = %d, want %d", got, want)
	}
}

// routeResponseSchemas 是三条路由的响应 schema。宿主逐字比较响应文档的 schema id
// 与路由声明的 responseSchema，所以失败文档也必须落在其中之一，而不是一个通用 error schema。
var routeResponseSchemas = map[string]bool{
	strings.TrimSuffix(schemaCatalogResponse, "@1"):    true,
	strings.TrimSuffix(schemaProductResponse, "@1"):    true,
	strings.TrimSuffix(schemaInstallURLResponse, "@1"): true,
	// 仅用于「宿主永远不会分发的未知路由」这条防御分支。
	strings.TrimSuffix(schemaErrorResponse, "@1"): true,
}

// assertError 校验一次对外失败：状态码、错误码，以及错误文档绑在本路由的 schema 上。
func assertError(t *testing.T, response *pluginwire.RouteResponse, wantStatus int, wantCode string) {
	t.Helper()
	assertStatus(t, response, wantStatus)
	schemaID := response.GetBody().GetSchemaId()
	if !routeResponseSchemas[schemaID] {
		t.Fatalf("error document schema = %q, want one of the route response schemas", schemaID)
	}
	values := response.GetBody().GetValue().AsMap()
	if got := values["code"]; got != wantCode {
		t.Fatalf("error code = %v, want %s", got, wantCode)
	}
	if message, _ := values["message"].(string); strings.TrimSpace(message) == "" {
		t.Fatalf("error message is empty")
	}
}

// assertErrorFor 断言错误文档绑定到指定的路由 schema（用于三条路由各一次的定点检查）。
func assertErrorFor(t *testing.T, response *pluginwire.RouteResponse, schemaRef string, wantStatus int, wantCode string) {
	t.Helper()
	assertStatus(t, response, wantStatus)
	values := assertJSONDocument(t, response, schemaRef)
	if got := values["code"]; got != wantCode {
		t.Fatalf("error code = %v, want %s", got, wantCode)
	}
}

func assertFetchedAt(t *testing.T, values map[string]any, want time.Time) {
	t.Helper()
	raw, ok := values["fetchedAt"].(string)
	if !ok {
		t.Fatalf("fetchedAt missing: %v", values["fetchedAt"])
	}
	if raw != want.UTC().Format(time.RFC3339) {
		t.Fatalf("fetchedAt = %s, want %s", raw, want.UTC().Format(time.RFC3339))
	}
}

func objectAt(t *testing.T, values map[string]any, key string) map[string]any {
	t.Helper()
	nested, ok := values[key].(map[string]any)
	if !ok {
		t.Fatalf("%s is not an object: %#v", key, values[key])
	}
	return nested
}

func arrayAt(t *testing.T, values map[string]any, key string) []any {
	t.Helper()
	nested, ok := values[key].([]any)
	if !ok {
		t.Fatalf("%s is not an array: %#v", key, values[key])
	}
	return nested
}

func writeUpstreamJSON(t *testing.T, w http.ResponseWriter, status int, payload any, headers map[string]string) {
	t.Helper()
	for name, value := range headers {
		w.Header().Set(name, value)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if payload == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		t.Errorf("encode fake upstream payload: %v", err)
	}
}

func catalogFixture() map[string]any {
	return map[string]any{
		"items": []any{
			map[string]any{
				"slug":          "demo-plugin",
				"extensionId":   "sforum.plugin.demo",
				"name":          "Demo Plugin",
				"kind":          "plugin",
				"summary":       "demo summary",
				"category":      "tools",
				"tags":          []any{"search-only"},
				"owner":         "someone",
				"iconUrl":       nil,
				"latestVersion": "1.2.0",
				"sforumVersion": ">=1.0.0",
				"updatedAt":     "2026-10-20T10:00:00Z",
				"platforms":     []any{map[string]any{"os": "linux", "arch": "amd64"}},
				"compatibility": map[string]any{"status": "unknown", "estimated": false},
			},
		},
		"total":      1,
		"nextCursor": "cursor-2",
	}
}

func productFixture() map[string]any {
	return map[string]any{
		"slug":        "demo-plugin",
		"extensionId": "sforum.plugin.demo",
		"name":        "Demo Plugin",
		"kind":        "plugin",
		"summary":     "demo summary",
		"readme": map[string]any{
			"html":      "<h1>Demo Plugin</h1>\n<p>Install it.</p>",
			"sourceUrl": "https://github.com/example/demo/blob/main/README.md",
			"sha":       strings.Repeat("d", 40),
			"fetchedAt": "2026-10-23T09:00:00Z",
			"byteSize":  4096,
		},
		"category":      "tools",
		"tags":          []any{"search-only"},
		"owner":         "someone",
		"iconUrl":       nil,
		"repoUrl":       "https://github.com/example/demo",
		"latestVersion": "1.2.0",
		"updatedAt":     "2026-10-20T10:00:00Z",
		"platforms":     []any{map[string]any{"os": "linux", "arch": "amd64"}},
		"compatibility": map[string]any{"status": "unknown", "estimated": false},
		"releases": []any{
			map[string]any{
				"version":       "1.2.0",
				"channel":       "stable",
				"publishedAt":   "2026-10-20T10:00:00Z",
				"sforumVersion": ">=1.0.0",
				"status":        "published",
				"digest":        strings.Repeat("a", 64),
				"notes":         "first",
				"capabilities":  []any{"host.api"},
				"assets": []any{
					map[string]any{
						"os": "linux", "arch": "amd64", "filename": "demo.zip",
						"size": 1024, "sha256": strings.Repeat("b", 64),
					},
				},
			},
			// channel 不在契约枚举里：必须被丢掉，而不是伪造一个 stable。
			map[string]any{
				"version":       "1.3.0-rc.1",
				"channel":       "nightly",
				"publishedAt":   "2026-10-21T10:00:00Z",
				"sforumVersion": ">=1.0.0",
				"status":        "published",
				"assets":        []any{},
			},
		},
	}
}

func downloadURLFixture() map[string]any {
	return map[string]any{
		"url":       "https://store.example.test/api/v1/download/token",
		"sha256":    strings.Repeat("c", 64),
		"size":      2048,
		"expiresAt": "2026-10-24T12:30:00Z",
	}
}

func assertFetchedAtParses(t *testing.T, values map[string]any) time.Time {
	t.Helper()
	raw, ok := values["fetchedAt"].(string)
	if !ok {
		t.Fatalf("fetchedAt missing: %v", values["fetchedAt"])
	}
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		t.Fatalf("fetchedAt %q is not RFC3339: %v", raw, err)
	}
	return parsed
}
