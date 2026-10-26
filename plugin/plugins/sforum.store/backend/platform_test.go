package main

import (
	"net/http"
	"runtime"
	"testing"
)

// 架构维度（platform）与版本维度（compat）是两条独立的轴，这里逐条钉住：
// 参数转发、非法值拒绝、字段映射、以及老商城缺字段时的回落。

func TestCatalogForwardsPlatformOnlyWhenWidened(t *testing.T) {
	cases := []struct {
		name       string
		params     map[string]string
		wantOnWire bool
	}{
		{name: "absent keeps the upstream default", params: map[string]string{}},
		// `platform=strict` 与省略在上游完全等价；转发它只会让 ETag 抖动。
		{name: "explicit strict is not forwarded", params: map[string]string{"platform": "strict"}},
		{name: "all is forwarded", params: map[string]string{"platform": "all"}, wantOnWire: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fake := newFakeUpstream(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
				writeUpstreamJSON(t, w, http.StatusOK, catalogFixture(), nil)
			})
			server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

			response := invokeRoute(t, server, routeCatalogID, testCase.params, nil)
			assertStatus(t, response, http.StatusOK)

			calls := fake.calls()
			if len(calls) != 1 {
				t.Fatalf("upstream calls = %d, want 1", len(calls))
			}
			got := calls[0].Query.Get("platform")
			if testCase.wantOnWire {
				if got != platformModeAll {
					t.Fatalf("upstream platform = %q, want %q", got, platformModeAll)
				}
			} else if calls[0].Query.Has("platform") {
				t.Fatalf("upstream query must not carry platform: %v", calls[0].Query)
			}
			// 架构维度放宽不等于改目标平台：os/arch 恒为宿主 runtime 值。
			if calls[0].Query.Get("os") != runtime.GOOS || calls[0].Query.Get("arch") != runtime.GOARCH {
				t.Fatalf("upstream os/arch = %q/%q, want %q/%q",
					calls[0].Query.Get("os"), calls[0].Query.Get("arch"), runtime.GOOS, runtime.GOARCH)
			}
		})
	}
}

func TestCatalogRejectsInvalidPlatformWithoutCallingUpstream(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		writeUpstreamJSON(t, w, http.StatusOK, catalogFixture(), nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	for _, value := range []string{"any", "ALL", "Strict", "0"} {
		response := invokeRoute(t, server, routeCatalogID, map[string]string{"platform": value}, nil)
		assertError(t, response, http.StatusBadRequest, codeInvalidRequest)
	}
	if fake.hits() != 0 {
		t.Fatalf("invalid platform must not reach the store, upstream hits = %d", fake.hits())
	}
}

func TestCatalogQueryValuesCarryPlatformAll(t *testing.T) {
	base := catalogQuery{Channel: channelStable, Limit: 18}
	if base.values().Has("platform") {
		t.Fatalf("strict (zero value) must not send platform: %v", base.values())
	}

	widened := catalogQuery{Channel: channelStable, Limit: 18, PlatformAll: true}
	values := widened.values()
	if got := values.Get("platform"); got != platformModeAll {
		t.Fatalf("platform = %q, want %q", got, platformModeAll)
	}
	// 放宽架构维度不能把 os/arch 一起丢掉：上游的 compatibility 判定要用它们。
	if values.Get("os") != runtime.GOOS || values.Get("arch") != runtime.GOARCH {
		t.Fatalf("os/arch = %q/%q", values.Get("os"), values.Get("arch"))
	}
}

func TestCatalogItemMapsLatestPlatforms(t *testing.T) {
	linux := map[string]any{"os": "linux", "arch": "amd64"}
	darwin := map[string]any{"os": "darwin", "arch": "arm64"}

	t.Run("upstream field wins over the union", func(t *testing.T) {
		item := upstreamSummary{
			Slug: "demo-plugin", ExtensionID: "sforum.plugin.demo", Kind: "plugin",
			LatestVersion: "2.0.0",
			Platforms:     []upstreamPlatform{{OS: "linux", Arch: "amd64"}, {OS: "darwin", Arch: "arm64"}},
			// 最新版只在 darwin 上发布：卡片必须报 darwin，而不是并集。
			LatestPlatforms: []upstreamPlatform{{OS: "darwin", Arch: "arm64"}},
		}
		values, ok := catalogItemValues(item, "", installedInventory{})
		if !ok {
			t.Fatal("expected the item to map")
		}
		assertPlatformList(t, values["latestPlatforms"], []map[string]any{darwin})
		assertPlatformList(t, values["platforms"], []map[string]any{linux, darwin})
	})

	t.Run("missing field falls back to the union", func(t *testing.T) {
		// 老商城没有 latestPlatforms：语义退化成「至少覆盖这些平台」，宁可少拦一次。
		item := upstreamSummary{
			Slug: "demo-plugin", ExtensionID: "sforum.plugin.demo", Kind: "plugin",
			LatestVersion: "1.2.0",
			Platforms:     []upstreamPlatform{{OS: "linux", Arch: "amd64"}},
		}
		values, ok := catalogItemValues(item, "", installedInventory{})
		if !ok {
			t.Fatal("expected the item to map")
		}
		assertPlatformList(t, values["latestPlatforms"], []map[string]any{linux})
	})

	t.Run("empty array is not the same as missing", func(t *testing.T) {
		// 上游明确给了 []：这一版没有发布资产。回落成并集会凭空造出一个平台，
		// 让页面以为「最新版支持你」。
		item := upstreamSummary{
			Slug: "demo-plugin", ExtensionID: "sforum.plugin.demo", Kind: "plugin",
			LatestVersion:   "2.0.0",
			Platforms:       []upstreamPlatform{{OS: "linux", Arch: "amd64"}},
			LatestPlatforms: []upstreamPlatform{},
		}
		values, ok := catalogItemValues(item, "", installedInventory{})
		if !ok {
			t.Fatal("expected the item to map")
		}
		assertPlatformList(t, values["latestPlatforms"], nil)
		assertPlatformList(t, values["platforms"], []map[string]any{linux})
	})
}

func TestProductMapsLatestPlatforms(t *testing.T) {
	linux := map[string]any{"os": "linux", "arch": "amd64"}
	darwin := map[string]any{"os": "darwin", "arch": "arm64"}

	result := productResult{product: &upstreamProduct{
		upstreamSummary: upstreamSummary{
			Slug: "demo-plugin", ExtensionID: "sforum.plugin.demo", Kind: "plugin",
			LatestVersion: "2.0.0",
			Platforms:     []upstreamPlatform{{OS: "linux", Arch: "amd64"}, {OS: "darwin", Arch: "arm64"}},
			// 详情页发布全部版本；latestPlatforms 仍只描述卡片指向的那一版。
			LatestPlatforms: []upstreamPlatform{{OS: "darwin", Arch: "arm64"}},
		},
		Releases: []upstreamRelease{
			{
				Version: "2.0.0", Channel: channelStable, PublishedAt: "2026-10-20T10:00:00Z",
				SForumVersion: ">=1.0.0", Status: "published",
				Assets: []upstreamAsset{{OS: "darwin", Arch: "arm64", Filename: "b.zip", Size: 1, SHA256: "b"}},
			},
			{
				Version: "1.0.0", Channel: channelStable, PublishedAt: "2026-08-01T00:00:00Z",
				SForumVersion: ">=1.0.0", Status: "published",
				Assets: []upstreamAsset{{OS: "linux", Arch: "amd64", Filename: "a.zip", Size: 1, SHA256: "a"}},
			},
		},
	}}

	values, dropped, err := productResponseValues(result, "", installedInventory{})
	if err != nil {
		t.Fatalf("productResponseValues: %v", err)
	}
	if dropped != 0 {
		t.Fatalf("dropped = %d, want 0", dropped)
	}
	product, ok := values["product"].(map[string]any)
	if !ok {
		t.Fatalf("product is not an object: %#v", values["product"])
	}
	assertPlatformList(t, product["latestPlatforms"], []map[string]any{darwin})
	assertPlatformList(t, product["platforms"], []map[string]any{linux, darwin})
}

func assertPlatformList(t *testing.T, value any, want []map[string]any) {
	t.Helper()
	list, ok := value.([]any)
	if !ok {
		t.Fatalf("platform list is %T, want []any", value)
	}
	if len(list) != len(want) {
		t.Fatalf("platform list = %#v, want %d entries", list, len(want))
	}
	for index, entry := range list {
		object, ok := entry.(map[string]any)
		if !ok {
			t.Fatalf("platform[%d] is %T, want map[string]any", index, entry)
		}
		if object["os"] != want[index]["os"] || object["arch"] != want[index]["arch"] {
			t.Fatalf("platform[%d] = %#v, want %#v", index, object, want[index])
		}
	}
}
