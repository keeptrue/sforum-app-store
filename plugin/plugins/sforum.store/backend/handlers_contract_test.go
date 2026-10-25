package main

import (
	"errors"
	"net/http"
	"strings"
	"testing"
)

// 本文件只覆盖本轮新增的对外契约：宿主版本转发、compat、installed /
// updateAvailable、分享卡绝对地址。三条路由的基础行为在 handlers_test.go。

// TestCatalogForwardsHostBuildAndCompat 覆盖新版本面的正例：宿主在握手时给了
// coreVersion/buildVersion，目录查询必须原样转发；调用方带来的 sforum 一律丢弃，
// 版本只能来自握手快照。
func TestCatalogForwardsHostBuildAndCompat(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusOK, catalogFixture(), nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
	stubHostBuild(server, "3.0.16", "dev-abc12")

	response := invokeRoute(t, server, routeCatalogID, map[string]string{
		"compat":      compatModeAll,
		"sforum":      "0.0.1",
		"sforumBuild": "forged",
	}, nil)
	assertStatus(t, response, http.StatusOK)

	call := fake.last(t)
	if got := call.Query.Get("sforum"); got != "3.0.16" {
		t.Errorf("upstream sforum = %q, want 3.0.16", got)
	}
	if got := call.Query.Get("sforumBuild"); got != "dev-abc12" {
		t.Errorf("upstream sforumBuild = %q, want dev-abc12", got)
	}
	if got := call.Query.Get("compat"); got != compatModeAll {
		t.Errorf("upstream compat = %q, want all", got)
	}
}

// TestCatalogOmitsHostBuildWhenHostDidNotProvideIt 覆盖旧宿主：没有 host_build 时
// 两个版本参数都不出现，目录保持 unknown；compat 仍按缺省 compatible 发送，上游在
// 拿不到版本时不做过滤。
func TestCatalogOmitsHostBuildWhenHostDidNotProvideIt(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusOK, catalogFixture(), nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	values := assertJSONDocument(t, invokeRoute(t, server, routeCatalogID,
		map[string]string{"sforum": "9.9.9", "sforumBuild": "forged"}, nil), schemaCatalogResponse)

	call := fake.last(t)
	for _, key := range []string{"sforum", "sforumBuild"} {
		if call.Query.Has(key) {
			t.Errorf("upstream query must not carry %s when the host build is unknown: %v", key, call.Query)
		}
	}
	if got := call.Query.Get("compat"); got != compatModeCompatible {
		t.Errorf("upstream compat = %q, want compatible", got)
	}
	item := arrayAt(t, values, "items")[0].(map[string]any)
	if compat := objectAt(t, item, "compatibility"); compat["status"] != compatibilityUnknown {
		t.Errorf("item compatibility = %v, want unknown", compat)
	}
}

// TestCatalogCompatModes 覆盖 compat 的合法取值：缺省 compatible，显式值原样转发。
func TestCatalogCompatModes(t *testing.T) {
	cases := []struct {
		name  string
		param string
		want  string
	}{
		{name: "absent defaults to compatible", param: "", want: compatModeCompatible},
		{name: "explicit compatible", param: "compatible", want: compatModeCompatible},
		{name: "explicit all", param: compatModeAll, want: compatModeAll},
		{name: "surrounding spaces are trimmed", param: " all ", want: compatModeAll},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
				writeUpstreamJSON(t, w, http.StatusOK, catalogFixture(), nil)
			})
			server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

			params := map[string]string{}
			if testCase.param != "" {
				params["compat"] = testCase.param
			}
			assertStatus(t, invokeRoute(t, server, routeCatalogID, params, nil), http.StatusOK)
			if got := fake.last(t).Query.Get("compat"); got != testCase.want {
				t.Fatalf("upstream compat = %q, want %q", got, testCase.want)
			}
		})
	}
}

// TestCatalogRejectsUnknownCompatValue：非法 compat 直接 400，不做静默回退，
// 也不把请求发给商城。
func TestCatalogRejectsUnknownCompatValue(t *testing.T) {
	fake := newFakeUpstream(t, nil)
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	for _, value := range []string{"strict", "ALL", "allx", "compatibles"} {
		t.Run(value, func(t *testing.T) {
			response := invokeRoute(t, server, routeCatalogID, map[string]string{"compat": value}, nil)
			assertError(t, response, http.StatusBadRequest, codeInvalidRequest)
		})
	}
	if fake.hits() != 0 {
		t.Fatalf("invalid compat must not reach the store, upstream hits = %d", fake.hits())
	}
}

// TestProductForwardsHostBuild 覆盖详情页的版本转发：有宿主版本就带上，未知则两个
// 参数都不出现（旧行为完全保留）。
func TestProductForwardsHostBuild(t *testing.T) {
	t.Run("known host", func(t *testing.T) {
		fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
			writeUpstreamJSON(t, w, http.StatusOK, productFixture(), nil)
		})
		server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
		stubHostBuild(server, "3.0.16", "dev-abc12")

		assertStatus(t, invokeRoute(t, server, routeProductID, map[string]string{"slug": "demo-plugin"}, nil), http.StatusOK)
		call := fake.last(t)
		if got := call.Query.Get("sforum"); got != "3.0.16" {
			t.Errorf("upstream sforum = %q, want 3.0.16", got)
		}
		if got := call.Query.Get("sforumBuild"); got != "dev-abc12" {
			t.Errorf("upstream sforumBuild = %q, want dev-abc12", got)
		}
		// 详情接口没有 compat 参数：过滤强度只属于目录。
		if call.Query.Has("compat") {
			t.Errorf("detail query must not carry compat: %v", call.Query)
		}
	})

	t.Run("unknown host", func(t *testing.T) {
		fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
			writeUpstreamJSON(t, w, http.StatusOK, productFixture(), nil)
		})
		server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

		assertStatus(t, invokeRoute(t, server, routeProductID, map[string]string{"slug": "demo-plugin"}, nil), http.StatusOK)
		call := fake.last(t)
		if len(call.Query) != 0 {
			t.Errorf("detail request must stay bare when the host build is unknown: %v", call.Query)
		}
	})
}

// catalogItemsWithInstalled 造两行目录：一行命中已装清单且落后，一行没有装。
func catalogItemsWithInstalled() map[string]any {
	return map[string]any{
		"items": []any{
			map[string]any{
				"slug": "installed-plugin", "extensionId": "sforum.plugin.installed",
				"name": "Installed", "kind": kindPlugin, "summary": "installed",
				"latestVersion": "2.0.0", "sforumVersion": ">=1.0.0",
				"updatedAt": "2026-10-20T10:00:00Z", "platforms": []any{},
			},
			map[string]any{
				"slug": "missing-plugin", "extensionId": "sforum.plugin.missing",
				"name": "Missing", "kind": kindPlugin, "summary": "missing",
				"latestVersion": "1.2.0", "sforumVersion": ">=1.0.0",
				"updatedAt": "2026-10-20T10:00:00Z", "platforms": []any{},
			},
		},
		"total": 2,
	}
}

// TestCatalogMarksInstalledAndUpdateAvailable 覆盖 installed 的命中与缺失，以及
// updateAvailable 的真假：清单里有同 id 才给结论，没有就是 null / false。
func TestCatalogMarksInstalledAndUpdateAvailable(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusOK, catalogItemsWithInstalled(), nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
	server.inventoryFetch = newFakeInventory().page(0, 0,
		installedRow("sforum.plugin.installed", "1.2.0", "enabled"),
		// 别的扩展的条目不能影响这两行。
		installedRow("sforum.plugin.unrelated", "3.0.0", "enabled"),
	).fetch

	values := assertJSONDocument(t, invokeRoute(t, server, routeCatalogID, nil, nil), schemaCatalogResponse)
	items := arrayAt(t, values, "items")
	if len(items) != 2 {
		t.Fatalf("items = %d, want 2", len(items))
	}

	installedItem := items[0].(map[string]any)
	installed := objectAt(t, installedItem, "installed")
	if installed["version"] != "1.2.0" || installed["status"] != "enabled" {
		t.Errorf("installed = %v, want 1.2.0/enabled", installed)
	}
	if got := installedItem["updateAvailable"]; got != true {
		t.Errorf("updateAvailable = %v, want true", got)
	}

	missingItem := items[1].(map[string]any)
	if got := missingItem["installed"]; got != nil {
		t.Errorf("installed = %v, want null when the extension is not in the inventory", got)
	}
	if got := missingItem["updateAvailable"]; got != false {
		t.Errorf("updateAvailable = %v, want false", got)
	}
}

// TestCatalogUpdateAvailableFalseForUnparseableVersions：清单版本或最新版本解析
// 不了时一律 false，不猜「大概能升级」。
func TestCatalogUpdateAvailableFalseForUnparseableVersions(t *testing.T) {
	cases := []struct {
		name    string
		version string
		latest  string
	}{
		{name: "unparseable inventory version", version: "dev-abc12", latest: "2.0.0"},
		{name: "unparseable latest version", version: "1.2.0", latest: "nightly"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			payload := catalogFixture()
			payload["items"] = []any{map[string]any{
				"slug": "installed-plugin", "extensionId": "sforum.plugin.installed",
				"name": "Installed", "kind": kindPlugin, "summary": "installed",
				"latestVersion": testCase.latest, "sforumVersion": ">=1.0.0",
				"updatedAt": "2026-10-20T10:00:00Z", "platforms": []any{},
			}}
			payload["total"] = 1
			fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
				writeUpstreamJSON(t, w, http.StatusOK, payload, nil)
			})
			server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
			server.inventoryFetch = newFakeInventory().page(0, 0,
				installedRow("sforum.plugin.installed", testCase.version, "enabled"),
			).fetch

			values := assertJSONDocument(t, invokeRoute(t, server, routeCatalogID, nil, nil), schemaCatalogResponse)
			item := arrayAt(t, values, "items")[0].(map[string]any)
			if got := item["updateAvailable"]; got != false {
				t.Fatalf("updateAvailable = %v, want false", got)
			}
			// installed 仍然照实给出：解析不了的是版本比较，不是清单本身。
			if installed := objectAt(t, item, "installed"); installed["version"] != testCase.version {
				t.Fatalf("installed = %v, want version %q", installed, testCase.version)
			}
		})
	}
}

// TestCatalogSurvivesInventoryFailure：清单查询失败（能力未授予、旧宿主、超时）
// 只能让 installed 变成 null，目录本身必须照常 200。
func TestCatalogSurvivesInventoryFailure(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusOK, catalogFixture(), nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
	server.inventoryFetch = newFakeInventory().fail(0, errors.New("host.permission_denied")).fetch

	values := assertJSONDocument(t, invokeRoute(t, server, routeCatalogID, nil, nil), schemaCatalogResponse)
	item := arrayAt(t, values, "items")[0].(map[string]any)
	if got := item["installed"]; got != nil {
		t.Errorf("installed = %v, want null", got)
	}
	if got := item["updateAvailable"]; got != false {
		t.Errorf("updateAvailable = %v, want false", got)
	}
}

// TestSocialImageURLIsAbsolute：商城发的是 /api/assets/<sha> 相对路径，目录与详情
// 都必须拼成绝对地址；上游没给时是显式 null。
func TestSocialImageURLIsAbsolute(t *testing.T) {
	sha := "/api/assets/" + strings.Repeat("a", 64)
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		if r.URL.Path == "/api/v1/catalog" {
			payload := catalogFixture()
			payload["items"].([]any)[0].(map[string]any)["socialImageUrl"] = sha
			writeUpstreamJSON(t, w, http.StatusOK, payload, nil)
			return
		}
		payload := productFixture()
		payload["socialImageUrl"] = sha
		writeUpstreamJSON(t, w, http.StatusOK, payload, nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
	want := fake.baseURL() + sha

	catalogValues := assertJSONDocument(t, invokeRoute(t, server, routeCatalogID, nil, nil), schemaCatalogResponse)
	item := arrayAt(t, catalogValues, "items")[0].(map[string]any)
	if got := item["socialImageUrl"]; got != want {
		t.Errorf("catalog socialImageUrl = %v, want %v", got, want)
	}

	productValues := assertJSONDocument(t, invokeRoute(t, server, routeProductID,
		map[string]string{"slug": "demo-plugin"}, nil), schemaProductResponse)
	product := objectAt(t, productValues, "product")
	if got := product["socialImageUrl"]; got != want {
		t.Errorf("product socialImageUrl = %v, want %v", got, want)
	}
}

// TestProductMarksInstalledState：详情页的 installed / updateAvailable 与目录同源。
func TestProductMarksInstalledState(t *testing.T) {
	t.Run("installed and outdated", func(t *testing.T) {
		fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
			writeUpstreamJSON(t, w, http.StatusOK, productFixture(), nil)
		})
		server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
		server.inventoryFetch = newFakeInventory().page(0, 0,
			installedRow("sforum.plugin.demo", "1.2.0", "enabled"),
		).fetch

		values := assertJSONDocument(t, invokeRoute(t, server, routeProductID,
			map[string]string{"slug": "demo-plugin"}, nil), schemaProductResponse)
		product := objectAt(t, values, "product")
		installed := objectAt(t, product, "installed")
		if installed["version"] != "1.2.0" || installed["status"] != "enabled" {
			t.Fatalf("installed = %v", installed)
		}
		// 夹具的 latestVersion 是 1.2.0：等值不算可升级。
		if got := product["updateAvailable"]; got != false {
			t.Fatalf("updateAvailable = %v, want false", got)
		}
	})

	t.Run("upgrade pending", func(t *testing.T) {
		fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
			payload := productFixture()
			payload["latestVersion"] = "2.0.0"
			writeUpstreamJSON(t, w, http.StatusOK, payload, nil)
		})
		server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
		server.inventoryFetch = newFakeInventory().page(0, 0,
			installedRow("sforum.plugin.demo", "1.2.0", "enabled"),
		).fetch

		values := assertJSONDocument(t, invokeRoute(t, server, routeProductID,
			map[string]string{"slug": "demo-plugin"}, nil), schemaProductResponse)
		product := objectAt(t, values, "product")
		if got := product["updateAvailable"]; got != true {
			t.Fatalf("updateAvailable = %v, want true", got)
		}
	})

	t.Run("not installed", func(t *testing.T) {
		fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
			writeUpstreamJSON(t, w, http.StatusOK, productFixture(), nil)
		})
		server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
		server.inventoryFetch = newFakeInventory().page(0, 0,
			installedRow("sforum.plugin.other", "1.2.0", "enabled"),
		).fetch

		values := assertJSONDocument(t, invokeRoute(t, server, routeProductID,
			map[string]string{"slug": "demo-plugin"}, nil), schemaProductResponse)
		product := objectAt(t, values, "product")
		if got := product["installed"]; got != nil {
			t.Fatalf("installed = %v, want null", got)
		}
	})
}
