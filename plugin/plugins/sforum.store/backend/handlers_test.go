package main

import (
	"encoding/json"
	"net/http"
	"runtime"
	"strings"
	"testing"

	pluginv2 "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2"
)

func TestHandlersNotConfiguredWithoutHostSettings(t *testing.T) {
	// 没有 Host 通道也没有注入设置：三条路由都必须收敛成 not_configured，
	// 而不是 panic、500 或空指针。
	server := &storeServer{Server: pluginv2.NewServer(), store: newStoreClient()}

	requests := map[string]struct {
		routeID string
		schema  string
		params  map[string]string
		body    map[string]any
	}{
		"catalog":     {routeID: routeCatalogID, schema: schemaCatalogResponse},
		"product":     {routeID: routeProductID, schema: schemaProductResponse, params: map[string]string{"slug": "demo-plugin"}},
		"install-url": {routeID: routeInstallURLID, schema: schemaInstallURLResponse, body: map[string]any{"slug": "demo-plugin", "os": "linux", "arch": "amd64"}},
	}
	for name, request := range requests {
		t.Run(name, func(t *testing.T) {
			response := invokeRoute(t, server, request.routeID, request.params, request.body)
			// 失败文档必须绑定在该路由自己的 responseSchema 上，而不是通用 error schema。
			assertErrorFor(t, response, request.schema, http.StatusServiceUnavailable, codeNotConfigured)
		})
	}
}

func TestHandlersNotConfiguredForUnusableBaseURL(t *testing.T) {
	for _, base := range []string{
		"",
		"http://store.example.test", // settings.go 只放行 https，这里再验一次
		"https://",
		"store.example.test",
	} {
		t.Run(base, func(t *testing.T) {
			server := newTestStoreServer(t, storeSettings{CatalogBaseURL: base, Channel: channelStable})
			response := invokeRoute(t, server, routeCatalogID, nil, nil)
			assertError(t, response, http.StatusServiceUnavailable, codeNotConfigured)
		})
	}
}

func TestCatalogForwardsFiltersRuntimeTargetAndReshapesResponse(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusOK, catalogFixture(), nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	response := invokeRoute(t, server, routeCatalogID, map[string]string{
		"channel":  "beta",
		"q":        " demo ",
		"category": " tools ",
		"cursor":   "c1",
		"limit":    "25",
		// 下面四个都不是插件契约参数：调用方带来的 os/arch 必须被 runtime 值覆盖，
		// sforum/sforumBuild 永远不转发（宿主没有暴露版本，§6.2）。
		"os": "windows", "arch": "386", "sforum": "1.2.3", "sforumBuild": "dev",
	}, nil)

	assertStatus(t, response, http.StatusOK)
	values := assertJSONDocument(t, response, schemaCatalogResponse)
	assertFetchedAtParses(t, values)

	calls := fake.calls()
	if len(calls) != 1 {
		t.Fatalf("upstream calls = %d, want 1", len(calls))
	}
	call := calls[0]
	if call.Method != http.MethodGet || call.Path != "/api/v1/catalog" {
		t.Fatalf("upstream request = %s %s", call.Method, call.Path)
	}
	want := map[string]string{
		"channel": "beta", "q": "demo", "category": "tools", "cursor": "c1", "limit": "25",
		"os": runtime.GOOS, "arch": runtime.GOARCH,
	}
	if got := len(call.Query); got != len(want) {
		t.Fatalf("upstream query keys = %v, want exactly %d keys", call.Query, len(want))
	}
	for key, value := range want {
		if got := call.Query.Get(key); got != value {
			t.Errorf("upstream query %s = %q, want %q", key, got, value)
		}
	}
	for _, key := range []string{"sforum", "sforumBuild"} {
		if call.Query.Has(key) {
			t.Errorf("upstream query must never carry %s", key)
		}
	}
	// 调用方没指定口径时不转发 compat：默认口径由商城按宿主决定，插件不替它补默认值。
	if call.Query.Has("compat") {
		t.Errorf("upstream query must not carry compat when the caller did not set it: %v", call.Query)
	}

	if got := values["total"]; got != float64(1) {
		t.Errorf("total = %v, want 1", got)
	}
	if got := values["nextCursor"]; got != "cursor-2" {
		t.Errorf("nextCursor = %v, want cursor-2", got)
	}
	if got := values["stale"]; got != false {
		t.Errorf("stale = %v, want false", got)
	}

	items := arrayAt(t, values, "items")
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	item, ok := items[0].(map[string]any)
	if !ok {
		t.Fatalf("item is not an object: %#v", items[0])
	}
	// 上游的 tags/owner 不属于插件 DTO，必须在映射里被丢掉。
	if _, exists := item["tags"]; exists {
		t.Errorf("item leaked upstream field tags")
	}
	if _, exists := item["owner"]; exists {
		t.Errorf("item leaked upstream field owner")
	}
	wantItemKeys := []string{
		"slug", "extensionId", "name", "kind", "summary", "category", "iconUrl",
		"socialImageUrl", "latestVersion", "installed", "updateAvailable",
		"sforumVersion", "updatedAt", "platforms", "latestPlatforms", "compatibility",
	}
	if len(item) != len(wantItemKeys) {
		t.Errorf("item keys = %v, want %v", item, wantItemKeys)
	}
	for _, key := range wantItemKeys {
		if _, exists := item[key]; !exists {
			t.Errorf("item missing key %s", key)
		}
	}
	if got := item["slug"]; got != "demo-plugin" {
		t.Errorf("item slug = %v", got)
	}
	if got := item["category"]; got != "tools" {
		t.Errorf("item category = %v, want tools", got)
	}
	if got := item["iconUrl"]; got != nil {
		t.Errorf("item iconUrl = %v, want nil", got)
	}
	// 上游没给分享卡时是显式 null；没有已装清单就是 null + false，不做推断。
	if got := item["socialImageUrl"]; got != nil {
		t.Errorf("item socialImageUrl = %v, want nil", got)
	}
	if got := item["installed"]; got != nil {
		t.Errorf("item installed = %v, want nil", got)
	}
	if got := item["updateAvailable"]; got != false {
		t.Errorf("item updateAvailable = %v, want false", got)
	}
	// 清单约束原样透出：这是产品事实，不是插件给出的兼容判词。
	if got := item["sforumVersion"]; got != ">=1.0.0" {
		t.Errorf("item sforumVersion = %v, want >=1.0.0", got)
	}
	platforms := arrayAt(t, item, "platforms")
	if len(platforms) != 1 {
		t.Fatalf("platforms = %v", platforms)
	}
	if platform, _ := platforms[0].(map[string]any); platform["os"] != "linux" || platform["arch"] != "amd64" {
		t.Errorf("platform = %v", platforms[0])
	}

	catalogCompat := objectAt(t, values, "compatibility")
	if catalogCompat["status"] != compatibilityUnknown || catalogCompat["estimated"] != false {
		t.Errorf("catalog compatibility = %v, want unknown/false", catalogCompat)
	}
	itemCompat := objectAt(t, item, "compatibility")
	if itemCompat["status"] != compatibilityUnknown || itemCompat["estimated"] != false {
		t.Errorf("item compatibility = %v, want unknown/false", itemCompat)
	}
}

func TestCatalogForcesDefaultChannelFromSettings(t *testing.T) {
	cases := []struct {
		name     string
		settings string
		want     string
	}{
		{"settings beta", channelBeta, channelBeta},
		{"settings unset falls back to stable", "", channelStable},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
				writeUpstreamJSON(t, w, http.StatusOK, catalogFixture(), nil)
			})
			server := newBoundStoreServer(t, fake, storeSettings{Channel: testCase.settings})

			assertStatus(t, invokeRoute(t, server, routeCatalogID, nil, nil), http.StatusOK)
			if got := fake.last(t).Query.Get("channel"); got != testCase.want {
				t.Fatalf("upstream channel = %q, want %q", got, testCase.want)
			}
		})
	}
}

func TestCatalogRejectsInvalidFilters(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusOK, catalogFixture(), nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	cases := map[string]map[string]string{
		"unknown channel":   {"channel": "nightly"},
		"non numeric limit": {"limit": "abc"},
		"zero limit":        {"limit": "0"},
		"limit too large":   {"limit": "101"},
		"q too long":        {"q": strings.Repeat("字", maxSearchLength+1)},
		"category too long": {"category": strings.Repeat("c", maxFilterLength+1)},
		"cursor too long":   {"cursor": strings.Repeat("c", maxCursorLength+1)},
	}
	for name, params := range cases {
		t.Run(name, func(t *testing.T) {
			response := invokeRoute(t, server, routeCatalogID, params, nil)
			assertError(t, response, http.StatusBadRequest, codeInvalidRequest)
		})
	}
	if fake.hits() != 0 {
		t.Fatalf("invalid filters must not reach the store, upstream hits = %d", fake.hits())
	}
}

func TestCatalogCompatibilityUnknownWhenUpstreamOmitsIt(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		// 上游既没有顶层 compatibility，条目里也没有。
		writeUpstreamJSON(t, w, http.StatusOK, map[string]any{
			"items": []any{map[string]any{
				"slug": "sforum.theme.minimal", "extensionId": "sforum.theme.minimal",
				"name": "Minimal", "kind": "theme", "summary": "theme",
				"latestVersion": "0.4.0", "updatedAt": "2026-10-20T10:00:00Z",
				"platforms": []any{},
			}},
			"total": 1,
		}, nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	values := assertJSONDocument(t, invokeRoute(t, server, routeCatalogID, nil, nil), schemaCatalogResponse)
	if compat := objectAt(t, values, "compatibility"); compat["status"] != compatibilityUnknown || compat["estimated"] != false {
		t.Fatalf("catalog compatibility = %v", compat)
	}
	item := arrayAt(t, values, "items")[0].(map[string]any)
	if compat := objectAt(t, item, "compatibility"); compat["status"] != compatibilityUnknown || compat["estimated"] != false {
		t.Fatalf("item compatibility = %v", compat)
	}
	// 上游没说约束就是一个空串，页面据此不渲染 chip；不许补一个编好的值。
	if got := item["sforumVersion"]; got != "" {
		t.Fatalf("item sforumVersion = %v, want empty", got)
	}
}

func TestCatalogCompatibilityKeepsKnownStatusAndConstraint(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		payload := catalogFixture()
		payload["compatibility"] = map[string]any{"status": "compatible", "estimated": true, "constraint": ">=1.0.0"}
		item := payload["items"].([]any)[0].(map[string]any)
		// 未知枚举不能被当成兼容结论。
		item["compatibility"] = map[string]any{"status": "maybe", "estimated": true}
		writeUpstreamJSON(t, w, http.StatusOK, payload, nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	values := assertJSONDocument(t, invokeRoute(t, server, routeCatalogID, nil, nil), schemaCatalogResponse)
	compat := objectAt(t, values, "compatibility")
	if compat["status"] != compatibilityCompatible || compat["estimated"] != true || compat["constraint"] != ">=1.0.0" {
		t.Fatalf("catalog compatibility = %v", compat)
	}
	item := arrayAt(t, values, "items")[0].(map[string]any)
	if itemCompat := objectAt(t, item, "compatibility"); itemCompat["status"] != compatibilityUnknown || itemCompat["estimated"] != false {
		t.Fatalf("item compatibility = %v", itemCompat)
	}
}

func TestCatalogSurfacesUpstreamServerError(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusInternalServerError, map[string]any{"code": "boom"}, nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
	assertError(t, invokeRoute(t, server, routeCatalogID, nil, nil), http.StatusBadGateway, codeUpstreamError)
}

func TestProductRejectsInvalidSlugWithoutCallingUpstream(t *testing.T) {
	fake := newFakeUpstream(t, nil)
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	for _, slug := range []string{"", "   ", strings.Repeat("a", 65), "../etc/passwd", "Demo_Plugin"} {
		t.Run(slug, func(t *testing.T) {
			response := invokeRoute(t, server, routeProductID, map[string]string{"slug": slug}, nil)
			assertError(t, response, http.StatusBadRequest, codeInvalidRequest)
		})
	}
	if fake.hits() != 0 {
		t.Fatalf("invalid slug must not reach the store, upstream hits = %d", fake.hits())
	}
}

func TestProductMapsUpstreamNotFound(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusNotFound, map[string]any{"code": "product_not_found", "message": "nope"}, nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	response := invokeRoute(t, server, routeProductID, map[string]string{"slug": "demo-plugin"}, nil)
	assertError(t, response, http.StatusNotFound, codeProductNotFound)
	if got := fake.last(t).Path; got != "/api/v1/products/demo-plugin" {
		t.Fatalf("upstream path = %q", got)
	}
}

func TestProductMapsUpstreamServerError(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusBadGateway, nil, nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
	assertError(t, invokeRoute(t, server, routeProductID, map[string]string{"slug": "demo-plugin"}, nil),
		http.StatusBadGateway, codeUpstreamError)
}

func TestProductReshapesDetail(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		payload := productFixture()
		// 旧版商城仍可能带这两个字段：插件必须丢弃。product.response 是
		// additionalProperties:false，多一个键就会让整条响应在宿主侧校验失败。
		payload["description"] = "demo description"
		payload["screenshots"] = []any{
			map[string]any{"url": "https://cdn.example.test/s1.png", "width": 800, "height": 600},
		}
		writeUpstreamJSON(t, w, http.StatusOK, payload, nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	response := invokeRoute(t, server, routeProductID, map[string]string{"slug": "demo-plugin"}, nil)
	assertStatus(t, response, http.StatusOK)
	values := assertJSONDocument(t, response, schemaProductResponse)
	assertFetchedAtParses(t, values)
	if got := values["stale"]; got != false {
		t.Fatalf("stale = %v, want false", got)
	}

	product := objectAt(t, values, "product")
	for _, leaked := range []string{"tags", "owner", "updatedAt", "compatibility", "description", "screenshots"} {
		if _, exists := product[leaked]; exists {
			t.Errorf("product leaked upstream field %s", leaked)
		}
	}
	readme := objectAt(t, product, "readme")
	if got := readme["html"]; got != "<h1>Demo Plugin</h1>\n<p>Install it.</p>" {
		t.Errorf("readme.html = %v", got)
	}
	if got := readme["sourceUrl"]; got != "https://github.com/example/demo/blob/main/README.md" {
		t.Errorf("readme.sourceUrl = %v", got)
	}
	if got := readme["sha"]; got != strings.Repeat("d", 40) {
		t.Errorf("readme.sha = %v", got)
	}
	if got := readme["fetchedAt"]; got != "2026-10-23T09:00:00Z" {
		t.Errorf("readme.fetchedAt = %v", got)
	}
	if got := readme["byteSize"]; got != float64(4096) {
		t.Errorf("readme.byteSize = %v", got)
	}
	if got := product["repoUrl"]; got != "https://github.com/example/demo" {
		t.Errorf("repoUrl = %v", got)
	}
	author := objectAt(t, product, "author")
	if author["username"] != "ada" || author["displayName"] != "Ada Lovelace" {
		t.Errorf("author forum half = %v", author)
	}
	if got := author["avatarUrl"]; got != "https://forum.example.test/avatars/ada.png" {
		t.Errorf("author.avatarUrl = %v", got)
	}
	// 论坛主页地址由商城按 issuer 基址拼好；插件只做过 http(s) 校验就原样透出。
	if got := author["profileUrl"]; got != "https://forum.example.test/u/ada" {
		t.Errorf("author.profileUrl = %v", got)
	}
	// 上游给的 url 被丢掉，链接由插件按 login 重新拼。
	github := objectAt(t, author, "github")
	if github["login"] != "example" || github["url"] != "https://github.com/example" {
		t.Errorf("author.github = %v", github)
	}
	if got := product["latestVersion"]; got != "1.2.0" {
		t.Errorf("latestVersion = %v", got)
	}

	// channel=nightly 不在枚举里：该版本被丢弃，绝不改写成 stable。
	releases := arrayAt(t, product, "releases")
	if len(releases) != 1 {
		t.Fatalf("releases = %v", releases)
	}
	release := releases[0].(map[string]any)
	if release["version"] != "1.2.0" || release["channel"] != channelStable {
		t.Fatalf("release = %v", release)
	}
	if release["notes"] != "first" {
		t.Errorf("release notes = %v", release["notes"])
	}
	// 原文与渲染结果同时透出：页面优先注入 notesHtml，老商城没有这个键才退回纯文本。
	if release["notesHtml"] != "<p>first</p>" {
		t.Errorf("release notesHtml = %v", release["notesHtml"])
	}
	// 宿主清单读不到时不算关系：页面按「未安装」处理，不写这个键。
	if _, exists := release["installedRelation"]; exists {
		t.Errorf("release leaked installedRelation without inventory: %v", release["installedRelation"])
	}
	if release["digest"] != strings.Repeat("a", 64) {
		t.Errorf("release digest = %v", release["digest"])
	}
	capabilities := arrayAt(t, release, "capabilities")
	if len(capabilities) != 1 || capabilities[0] != "host.api" {
		t.Errorf("capabilities = %v", capabilities)
	}
	assets := arrayAt(t, release, "assets")
	if len(assets) != 1 {
		t.Fatalf("assets = %v", assets)
	}
	asset := assets[0].(map[string]any)
	if asset["filename"] != "demo.zip" || asset["size"] != float64(1024) {
		t.Errorf("asset = %v", asset)
	}
}

// TestProductReadmeIsNullWhenUnavailable 覆盖「商城还没读到 README」的三种上游形状：
// 显式 null、字段缺失、以及残缺对象（有 html 但缺 sourceUrl/fetchedAt）。三者都必须
// 输出显式 `readme: null`，页面据此显示占位文案，而不是渲染半截 HTML 或 502。
func TestProductReadmeIsNullWhenUnavailable(t *testing.T) {
	cases := map[string]func(payload map[string]any){
		"explicit null": func(payload map[string]any) {
			payload["readme"] = nil
		},
		"missing key": func(payload map[string]any) {
			delete(payload, "readme")
		},
		"incomplete object": func(payload map[string]any) {
			payload["readme"] = map[string]any{"html": "<h1>Demo Plugin</h1>"}
		},
	}

	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
				payload := productFixture()
				mutate(payload)
				writeUpstreamJSON(t, w, http.StatusOK, payload, nil)
			})
			server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

			response := invokeRoute(t, server, routeProductID, map[string]string{"slug": "demo-plugin"}, nil)
			values := assertJSONDocument(t, response, schemaProductResponse)
			product := objectAt(t, values, "product")
			readme, exists := product["readme"]
			if !exists {
				t.Fatalf("product is missing the explicit readme key: %v", product)
			}
			if readme != nil {
				t.Fatalf("readme = %v, want null", readme)
			}
		})
	}
}

func TestInstallURLRejectsBadBodies(t *testing.T) {
	valid := map[string]any{"slug": "demo-plugin", "os": "linux", "arch": "amd64"}

	bodies := map[string]map[string]any{
		"missing slug":   {"os": "linux", "arch": "amd64"},
		"missing os":     {"slug": "demo-plugin", "arch": "amd64"},
		"missing arch":   {"slug": "demo-plugin", "os": "linux"},
		"slug too long":  {"slug": strings.Repeat("a", 65), "os": "linux", "arch": "amd64"},
		"slug traversal": {"slug": "../../etc/passwd", "os": "linux", "arch": "amd64"},
		"non string os":  {"slug": "demo-plugin", "os": 42, "arch": "amd64"},
		"bad version":    {"slug": "demo-plugin", "os": "linux", "arch": "amd64", "version": "../1.0.0"},
		"unknown field":  {"slug": "demo-plugin", "os": "linux", "arch": "amd64", "product": "other"},
	}

	for name, body := range bodies {
		t.Run(name, func(t *testing.T) {
			fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
				writeUpstreamJSON(t, w, http.StatusOK, downloadURLFixture(), nil)
			})
			server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

			response := invokeRoute(t, server, routeInstallURLID, nil, body)
			assertError(t, response, http.StatusBadRequest, codeInvalidRequest)
			if fake.hits() != 0 {
				t.Fatalf("invalid body must not reach the store, upstream hits = %d", fake.hits())
			}
		})
	}

	t.Run("missing body", func(t *testing.T) {
		fake := newFakeUpstream(t, nil)
		server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
		response := invokeRoute(t, server, routeInstallURLID, nil, nil)
		assertError(t, response, http.StatusBadRequest, codeInvalidRequest)
	})

	t.Run("valid body sanity", func(t *testing.T) {
		fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
			writeUpstreamJSON(t, w, http.StatusOK, downloadURLFixture(), nil)
		})
		server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
		assertStatus(t, invokeRoute(t, server, routeInstallURLID, nil, valid), http.StatusOK)
	})
}

// TestInstallURLBodyCannotRedirectClient 证明请求体里的值只能是「选哪个包」，
// 不能是「去哪里取」：带 url 字段的请求被拒绝，任何主机都没收到请求；
// 即使商城把外部地址当作签名链接返回，插件也只把它当数据回传，从不访问。
func TestInstallURLBodyCannotRedirectClient(t *testing.T) {
	attacker := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusOK, downloadURLFixture(), nil)
	})
	configured := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		payload := downloadURLFixture()
		payload["url"] = attacker.baseURL() + "/signed"
		writeUpstreamJSON(t, w, http.StatusOK, payload, nil)
	})
	server := newBoundStoreServer(t, configured, storeSettings{Channel: channelStable})

	rejected := invokeRoute(t, server, routeInstallURLID, nil, map[string]any{
		"slug": "demo-plugin", "os": "linux", "arch": "amd64",
		"url": attacker.baseURL() + "/steal",
	})
	assertError(t, rejected, http.StatusBadRequest, codeInvalidRequest)
	if attacker.hits() != 0 {
		t.Fatalf("attacker upstream received %d requests for a body-supplied url", attacker.hits())
	}
	if configured.hits() != 0 {
		t.Fatalf("configured upstream received %d requests for an invalid body", configured.hits())
	}

	// 合法请求：只有配置的基址被访问，返回的签名链接只是数据。
	response := invokeRoute(t, server, routeInstallURLID, nil, map[string]any{
		"slug": "demo-plugin", "os": "linux", "arch": "amd64",
	})
	values := assertJSONDocument(t, response, schemaInstallURLResponse)
	if got := values["url"]; got != attacker.baseURL()+"/signed" {
		t.Fatalf("response url = %v, want the passthrough value", got)
	}
	if attacker.hits() != 0 {
		t.Fatalf("plugin must never fetch the signed url, attacker hits = %d", attacker.hits())
	}
	if configured.hits() != 1 {
		t.Fatalf("configured upstream hits = %d, want 1", configured.hits())
	}
}

func TestInstallURLPassesThroughSignedLink(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusOK, downloadURLFixture(), nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	response := invokeRoute(t, server, routeInstallURLID, nil, map[string]any{
		"slug": "demo-plugin", "version": "1.2.0", "os": "linux", "arch": "amd64",
	})
	assertStatus(t, response, http.StatusOK)
	values := assertJSONDocument(t, response, schemaInstallURLResponse)

	want := downloadURLFixture()
	if len(values) != len(want) {
		t.Fatalf("response keys = %v, want exactly %d fields", values, len(want))
	}
	if values["url"] != want["url"] {
		t.Errorf("url = %v", values["url"])
	}
	if values["sha256"] != want["sha256"] {
		t.Errorf("sha256 = %v", values["sha256"])
	}
	if values["size"] != float64(2048) {
		t.Errorf("size = %v", values["size"])
	}
	if values["expiresAt"] != want["expiresAt"] {
		t.Errorf("expiresAt = %v", values["expiresAt"])
	}

	call := fake.last(t)
	if call.Method != http.MethodPost || call.Path != "/api/v1/download-urls" {
		t.Fatalf("upstream request = %s %s", call.Method, call.Path)
	}
	if got := call.Header.Get("Content-Type"); got != upstreamJSONMedia {
		t.Errorf("upstream Content-Type = %q", got)
	}
	var payload map[string]any
	if err := json.Unmarshal(call.Body, &payload); err != nil {
		t.Fatalf("decode upstream body: %v", err)
	}
	wantPayload := map[string]any{
		"product": "demo-plugin", "version": "1.2.0", "os": "linux", "arch": "amd64",
	}
	if len(payload) != len(wantPayload) {
		t.Fatalf("upstream body = %v, want %v", payload, wantPayload)
	}
	for key, value := range wantPayload {
		if payload[key] != value {
			t.Errorf("upstream body %s = %v, want %v", key, payload[key], value)
		}
	}
}

func TestInstallURLMapsUpstreamFailures(t *testing.T) {
	cases := []struct {
		name       string
		status     int
		payload    any
		wantStatus int
		wantCode   string
	}{
		{"not found", http.StatusNotFound, map[string]any{"code": "asset_not_found"}, http.StatusNotFound, codeAssetNotFound},
		{"release not found", http.StatusNotFound, map[string]any{"code": "release_not_found"}, http.StatusNotFound, codeAssetNotFound},
		{"bad request", http.StatusBadRequest, map[string]any{"code": "invalid_request"}, http.StatusNotFound, codeAssetNotFound},
		{"server error", http.StatusInternalServerError, map[string]any{"code": "boom"}, http.StatusBadGateway, codeUpstreamError},
		{"service unavailable", http.StatusServiceUnavailable, nil, http.StatusBadGateway, codeUpstreamError},
		// 上游 200 但缺少 sha256：宁可 502，也不能把不合法的链接交给宿主去装。
		{"invalid signed payload", http.StatusOK, map[string]any{
			"url": "https://store.example.test/api/v1/download/t", "size": 1, "expiresAt": "2026-10-24T12:30:00Z",
		}, http.StatusBadGateway, codeUpstreamError},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
				writeUpstreamJSON(t, w, testCase.status, testCase.payload, nil)
			})
			server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
			response := invokeRoute(t, server, routeInstallURLID, nil, map[string]any{
				"slug": "demo-plugin", "os": "linux", "arch": "amd64",
			})
			assertError(t, response, testCase.wantStatus, testCase.wantCode)
		})
	}
}

func TestUnknownRouteIsReported(t *testing.T) {
	server := &storeServer{Server: pluginv2.NewServer(), store: newStoreClient()}
	response := invokeRoute(t, server, "sforum.store.route.nope", nil, nil)
	assertError(t, response, http.StatusNotFound, "route_not_found")
}
