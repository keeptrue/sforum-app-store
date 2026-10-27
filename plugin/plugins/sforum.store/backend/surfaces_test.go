package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	pluginwire "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2/gen/sforum/plugin/v2"
	protocolwire "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2/gen/sforum/protocol/v2"
)

// 这条 surface 的测试全部走真实路径：真实的 HTTP 假上游、真实的 catalogQuery
// 序列化、真实的 renderUpdateSurface。唯一被替换的是 Host（设置与握手版本），
// 因为单测不启动 go-plugin 运行时。

func surfaceInput(locale string, resources ...map[string]any) map[string]any {
	return map[string]any{
		"placementId":              "core.component.page.admin.extensions.plugins",
		"placementContractVersion": "sforum.component.page.admin.extensions.plugins@1",
		"kind":                     "list_column",
		"locale":                   locale,
		"route":                    map[string]any{"path": "/extensions/plugins"},
		"resources":                toAnySlice(resources),
		"filters":                  map[string]any{},
		"selection":                "",
		"context":                  map[string]any{"resourceType": "extension", "page": "plugins"},
	}
}

func surfaceResourceInput(id, kind, version, staged, source string) map[string]any {
	return map[string]any{
		"id": id,
		"attributes": map[string]any{
			"version":       version,
			"stagedVersion": staged,
			"type":          kind,
			"status":        "enabled",
			"source":        source,
		},
	}
}

func surfaceCatalogItem(slug, extensionID, kind, latest string) map[string]any {
	return map[string]any{
		"slug":          slug,
		"extensionId":   extensionID,
		"name":          slug,
		"kind":          kind,
		"latestVersion": latest,
	}
}

func surfaceCatalog(items ...map[string]any) map[string]any {
	return map[string]any{"items": toAnySlice(items), "total": len(items), "nextCursor": nil}
}

func toAnySlice[T any](values []T) []any {
	result := make([]any, len(values))
	for index, value := range values {
		result[index] = value
	}
	return result
}

func surfaceCells(t *testing.T, result map[string]any) map[string]any {
	t.Helper()
	cells, ok := result["cells"].(map[string]any)
	if !ok {
		t.Fatalf("cells is not an object: %#v", result["cells"])
	}
	return cells
}

func surfaceLinks(t *testing.T, result map[string]any) map[string]any {
	t.Helper()
	links, ok := result["links"].(map[string]any)
	if !ok {
		t.Fatalf("links is not an object: %#v", result["links"])
	}
	return links
}

func renderSurface(
	t *testing.T,
	server *storeServer,
	locale string,
	resources ...map[string]any,
) (map[string]any, *surfaceError) {
	t.Helper()
	return server.renderUpdateSurface(
		context.Background(), updateSurfaceDeclarations[0], emptyRequestContext(),
		surfaceInput(locale, resources...),
	)
}

// 清单是宿主看到的唯一真相：Go 里的声明必须与 manifest/admin-surfaces.json 逐字段一致，
// 否则宿主按 id 调过来时 ContractVersion 会对不上。
func TestUpdateSurfaceDeclarationsMatchManifest(t *testing.T) {
	body, err := os.ReadFile("../manifest/admin-surfaces.json")
	if err != nil {
		t.Fatalf("read admin surfaces manifest: %v", err)
	}
	var declared []struct {
		ID                       string `json:"id"`
		ContractVersion          string `json:"contractVersion"`
		Kind                     string `json:"kind"`
		Action                   string `json:"action"`
		PlacementID              string `json:"placementId"`
		PlacementContractVersion string `json:"placementContractVersion"`
		Handler                  string `json:"handler"`
		PropsSchema              string `json:"propsSchema"`
		ResultSchema             string `json:"resultSchema"`
		Operation                string `json:"operation"`
		Permission               string `json:"permission"`
		Priority                 int    `json:"priority"`
	}
	if err := json.Unmarshal(body, &declared); err != nil {
		t.Fatalf("decode admin surfaces manifest: %v", err)
	}
	if len(declared) != len(updateSurfaceDeclarations) {
		t.Fatalf("manifest declares %d surfaces, code declares %d",
			len(declared), len(updateSurfaceDeclarations))
	}

	byID := make(map[string]updateSurfaceDeclaration, len(updateSurfaceDeclarations))
	for _, declaration := range updateSurfaceDeclarations {
		if declaration.contractVersion != declaration.id+"@3" {
			t.Fatalf("%s contractVersion = %q", declaration.id, declaration.contractVersion)
		}
		byID[declaration.id] = declaration
	}

	for _, surface := range declared {
		declaration, ok := byID[surface.ID]
		if !ok {
			t.Fatalf("manifest surface %q has no code declaration", surface.ID)
		}
		if surface.ContractVersion != declaration.contractVersion ||
			surface.PlacementID != declaration.placementID ||
			surface.PlacementContractVersion != declaration.placementContractVersion {
			t.Fatalf("surface %q drifted from code: %+v", surface.ID, surface)
		}
		if surface.Kind != "list_column" || surface.Action != "add" || surface.Operation != "query" {
			t.Fatalf("surface %q has unexpected kind/action/operation: %+v", surface.ID, surface)
		}
		if surface.Handler != updateSurfaceHandler ||
			surface.PropsSchema != updateSurfacePropsSchema ||
			surface.ResultSchema != updateSurfaceResultSchema ||
			surface.Permission != "extension.view" ||
			surface.Priority != 10 {
			t.Fatalf("surface %q has unexpected contract fields: %+v", surface.ID, surface)
		}
	}
}

// props schema 必须与 Core 的 useAdminListSurfaces.queryInput() 完全对齐：
// 少一个字段就会每次被 ValidateProps 拒绝，多一个字段就是放宽了未知输入。
func TestUpdateSurfacePropsSchemaMatchesCoreInput(t *testing.T) {
	var props struct {
		Required             []string `json:"required"`
		AdditionalProperties bool     `json:"additionalProperties"`
		Properties           map[string]struct {
			Const string `json:"const"`
		} `json:"properties"`
	}
	body, err := os.ReadFile("../schemas/admin-updates.props.json")
	if err != nil {
		t.Fatalf("read props schema: %v", err)
	}
	if err := json.Unmarshal(body, &props); err != nil {
		t.Fatalf("decode props schema: %v", err)
	}

	want := []string{
		"placementId", "placementContractVersion", "kind", "locale",
		"route", "resources", "filters", "selection", "context",
	}
	if len(props.Required) != len(want) {
		t.Fatalf("required = %v, want %v", props.Required, want)
	}
	for index, key := range want {
		if props.Required[index] != key {
			t.Fatalf("required[%d] = %q, want %q", index, props.Required[index], key)
		}
	}
	if props.Properties["kind"].Const != "list_column" {
		t.Fatalf("kind const = %q", props.Properties["kind"].Const)
	}
	// 顶层保持 additive：Core 以后给 queryInput() 加字段时，三页 surface 不能因此 422。
	// 插件只读已知字段，未知字段忽略；已知字段的形状仍由 properties 约束。
	if !props.AdditionalProperties {
		t.Fatal("props schema must stay additive (additionalProperties: true)")
	}
}

// result schema 的 links 是本批唯一的新形状：Core 只接受同源后台路径。
func TestUpdateSurfaceResultSchemaLinksShape(t *testing.T) {
	var result struct {
		Required   []string `json:"required"`
		Properties map[string]struct {
			AdditionalProperties struct {
				Pattern   string `json:"pattern"`
				MaxLength int    `json:"maxLength"`
			} `json:"additionalProperties"`
		} `json:"properties"`
	}
	body, err := os.ReadFile("../schemas/admin-updates.result.json")
	if err != nil {
		t.Fatalf("read result schema: %v", err)
	}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("decode result schema: %v", err)
	}
	for _, key := range []string{"title", "tone", "icon", "cells", "links"} {
		found := false
		for _, required := range result.Required {
			if required == key {
				found = true
			}
		}
		if !found {
			t.Fatalf("result schema does not require %q: %v", key, result.Required)
		}
	}

	links := result.Properties["links"].AdditionalProperties
	if links.MaxLength != 512 {
		t.Fatalf("links maxLength = %d, want 512", links.MaxLength)
	}
	pattern, err := regexp.Compile(links.Pattern)
	if err != nil {
		t.Fatalf("links pattern does not compile: %v", err)
	}
	if !pattern.MatchString(updateSurfaceLink("demo-plugin")) {
		t.Fatalf("generated link %q does not match the schema pattern", updateSurfaceLink("demo-plugin"))
	}
	for _, unsafe := range []string{"//evil.example.test", "/a\\b", "relative/path"} {
		if pattern.MatchString(unsafe) {
			t.Fatalf("links pattern accepts unsafe value %q", unsafe)
		}
	}
}

func TestUpdateSurfaceSkipsBuiltinAndUnusableResources(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusOK, surfaceCatalog(), nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	result, failure := renderSurface(t, server, "zh-CN",
		surfaceResourceInput("sforum.builtin", "plugin", "1.0.0", "", "builtin"),
		surfaceResourceInput("sforum.theme-paper", "extension", "1.0.0", "", ""),
		surfaceResourceInput("Bad.ID", "plugin", "1.0.0", "", ""),
		surfaceResourceInput("sforum.dev-version", "plugin", "dev", "", ""),
		surfaceResourceInput("sforum.no-version", "plugin", "", "", ""),
	)
	if failure != nil {
		t.Fatalf("render failed: %v", failure)
	}
	if hits := fake.hits(); hits != 0 {
		t.Fatalf("no usable resource should reach upstream, hits = %d", hits)
	}
	if cells := surfaceCells(t, result); len(cells) != 0 {
		t.Fatalf("cells = %v, want empty", cells)
	}
}

func TestUpdateSurfaceBadgesOnlyForNewerCompatibleKinds(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusOK, surfaceCatalog(
			surfaceCatalogItem("markdown", "sforum.markdown", "plugin", "1.5.0"),
			surfaceCatalogItem("paper", "sforum.theme-paper", "theme", "2.0.0"),
			surfaceCatalogItem("same", "sforum.same", "plugin", "1.0.0"),
			surfaceCatalogItem("kind-drift", "sforum.kind-drift", "theme", "9.9.9"),
		), nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	result, failure := renderSurface(t, server, "zh-CN",
		surfaceResourceInput("sforum.markdown", "plugin", "1.0.0", "", ""),
		surfaceResourceInput("sforum.theme-paper", "theme", "1.9.0", "", ""),
		surfaceResourceInput("sforum.same", "plugin", "1.0.0", "", ""),
		// 上游说它是 theme，本地清单说是 plugin：类型不一致就不下结论。
		surfaceResourceInput("sforum.kind-drift", "plugin", "1.0.0", "", ""),
	)
	if failure != nil {
		t.Fatalf("render failed: %v", failure)
	}

	cells := surfaceCells(t, result)
	links := surfaceLinks(t, result)
	if len(cells) != 2 {
		t.Fatalf("cells = %v, want exactly two badges", cells)
	}
	if cells["sforum.markdown"] != "商城有新版 v1.5.0" {
		t.Fatalf("markdown cell = %v", cells["sforum.markdown"])
	}
	if cells["sforum.theme-paper"] != "商城有新版 v2.0.0" {
		t.Fatalf("paper cell = %v", cells["sforum.theme-paper"])
	}
	if _, exists := cells["sforum.same"]; exists {
		t.Fatalf("equal version must not be a badge: %v", cells)
	}
	if _, exists := cells["sforum.kind-drift"]; exists {
		t.Fatalf("kind mismatch must not be a badge: %v", cells)
	}
	if links["sforum.markdown"] != "/extensions/sforum.store/pages/catalog?product=markdown" {
		t.Fatalf("markdown link = %v", links["sforum.markdown"])
	}
}

func TestUpdateSurfaceTreatsStagedVersionAsAlreadyFetched(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusOK, surfaceCatalog(
			surfaceCatalogItem("staged-behind", "sforum.staged-behind", "plugin", "1.5.0"),
			surfaceCatalogItem("staged-ahead", "sforum.staged-ahead", "plugin", "1.5.0"),
		), nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	result, failure := renderSurface(t, server, "zh-CN",
		surfaceResourceInput("sforum.staged-behind", "plugin", "1.0.0", "1.2.0", ""),
		surfaceResourceInput("sforum.staged-ahead", "plugin", "1.0.0", "2.0.0", ""),
	)
	if failure != nil {
		t.Fatalf("render failed: %v", failure)
	}
	cells := surfaceCells(t, result)
	if _, exists := cells["sforum.staged-behind"]; !exists {
		t.Fatalf("1.2.0 staged is still behind 1.5.0: %v", cells)
	}
	if _, exists := cells["sforum.staged-ahead"]; exists {
		t.Fatalf("2.0.0 staged already covers 1.5.0: %v", cells)
	}
}

func TestUpdateSurfaceNotConfiguredReturnsEmptyWithoutUpstream(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		t.Errorf("upstream must not be called without a configured store")
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
	server.settingsOverride = &storeSettings{Channel: channelStable}

	result, failure := renderSurface(t, server, "en-US",
		surfaceResourceInput("sforum.markdown", "plugin", "1.0.0", "", ""),
	)
	if failure != nil {
		t.Fatalf("render failed: %v", failure)
	}
	if len(surfaceCells(t, result)) != 0 || len(surfaceLinks(t, result)) != 0 {
		t.Fatalf("unconfigured store must produce empty cells/links: %v", result)
	}
	if result["title"] != "Store updates" {
		t.Fatalf("en-US title = %v", result["title"])
	}
}

func TestUpdateSurfaceUpstreamFailureIsTypedAndRetryable(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusInternalServerError, map[string]any{"code": "internal_error"}, nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	_, failure := renderSurface(t, server, "zh-CN",
		surfaceResourceInput("sforum.markdown", "plugin", "1.0.0", "", ""),
	)
	if failure == nil {
		t.Fatal("upstream failure must be a typed error")
	}
	if failure.code != protocolwire.ErrorCode_ERROR_CODE_UNAVAILABLE || !failure.retryable {
		t.Fatalf("failure = %+v", failure)
	}
	if strings.Contains(failure.message, "https://") || strings.Contains(failure.reason, "https://") {
		t.Fatalf("failure leaks the store URL: %+v", failure)
	}
}

// 4xx 不是一种东西：只有 400（旧商城不认识 extensionIds）可以降级成空结果，
// 401/403/404/429 必须如实上报，否则真实故障会被静默成「没有更新」。
func TestUpdateSurfaceUpstreamRejectionSemantics(t *testing.T) {
	cases := []struct {
		name       string
		status     int
		wantEmpty  bool
		wantReason string
		wantRetry  bool
	}{
		{"old store rejects extensionIds", http.StatusBadRequest, true, "", false},
		{"unauthorized", http.StatusUnauthorized, false, "sforum.store.surface.upstream_rejected", false},
		{"forbidden", http.StatusForbidden, false, "sforum.store.surface.upstream_rejected", false},
		{"missing catalog path", http.StatusNotFound, false, "sforum.store.surface.upstream_rejected", false},
		{"rate limited", http.StatusTooManyRequests, false, "sforum.store.surface.upstream_unavailable", true},
		{"server error", http.StatusInternalServerError, false, "sforum.store.surface.upstream_unavailable", true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
				writeUpstreamJSON(t, w, testCase.status, map[string]any{"code": "upstream"}, nil)
			})
			server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

			result, failure := renderSurface(t, server, "zh-CN",
				surfaceResourceInput("sforum.markdown", "plugin", "1.0.0", "", ""),
			)
			if testCase.wantEmpty {
				if failure != nil {
					t.Fatalf("status %d must degrade, not fail: %v", testCase.status, failure)
				}
				if len(surfaceCells(t, result)) != 0 {
					t.Fatalf("status %d must not fabricate badges: %v", testCase.status, result)
				}
				return
			}
			if failure == nil {
				t.Fatalf("status %d must be a typed error", testCase.status)
			}
			if failure.code != protocolwire.ErrorCode_ERROR_CODE_UNAVAILABLE ||
				failure.reason != testCase.wantReason || failure.retryable != testCase.wantRetry {
				t.Fatalf("status %d failure = %+v", testCase.status, failure)
			}
		})
	}
}

func TestUpdateSurfaceNotFoundExplainsThePath(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusNotFound, map[string]any{"code": "not_found"}, nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	_, failure := renderSurface(t, server, "zh-CN",
		surfaceResourceInput("sforum.markdown", "plugin", "1.0.0", "", ""),
	)
	if failure == nil || !strings.Contains(failure.message, "目录") {
		t.Fatalf("404 message must point at the catalog path: %+v", failure)
	}
}

func TestUpdateSurfaceStaleCacheFailsClosed(t *testing.T) {
	clock := newTestClock(baseTestTime())
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		if call == 1 {
			writeUpstreamJSON(t, w, http.StatusOK, surfaceCatalog(
				surfaceCatalogItem("markdown", "sforum.markdown", "plugin", "1.5.0"),
			), nil)
			return
		}
		writeUpstreamJSON(t, w, http.StatusInternalServerError, map[string]any{"code": "internal_error"}, nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
	server.store.now = clock.now

	if _, failure := renderSurface(t, server, "zh-CN",
		surfaceResourceInput("sforum.markdown", "plugin", "1.0.0", "", ""),
	); failure != nil {
		t.Fatalf("first read failed: %v", failure)
	}

	clock.advance(11 * time.Minute)
	if _, failure := renderSurface(t, server, "zh-CN",
		surfaceResourceInput("sforum.markdown", "plugin", "1.0.0", "", ""),
	); failure == nil || failure.code != protocolwire.ErrorCode_ERROR_CODE_UNAVAILABLE {
		t.Fatalf("stale cache must fail closed, got %+v", failure)
	}
}

func TestUpdateSurfaceChunksSortedUniqueIDs(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusOK, surfaceCatalog(), nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	resources := make([]map[string]any, 0, 151)
	for index := 0; index < 150; index++ {
		resources = append(resources, surfaceResourceInput(
			fmt.Sprintf("sforum.id-%03d", index), "plugin", "1.0.0", "", ""))
	}
	// 重复 ID 只能出现一次，且不能挤占另一个 ID 的位置。
	resources = append(resources, surfaceResourceInput("sforum.id-000", "plugin", "1.0.0", "", ""))

	if _, failure := renderSurface(t, server, "zh-CN", resources...); failure != nil {
		t.Fatalf("render failed: %v", failure)
	}

	calls := fake.calls()
	if len(calls) != 2 {
		t.Fatalf("upstream calls = %d, want 2 chunks", len(calls))
	}
	for index, call := range calls {
		if got := call.Query.Get("channel"); got != channelStable {
			t.Fatalf("chunk %d channel = %q", index, got)
		}
		if got := call.Query.Get("limit"); got != "100" {
			t.Fatalf("chunk %d limit = %q", index, got)
		}
		if got := call.Query.Get("compat"); got != compatModeAll {
			t.Fatalf("chunk %d compat = %q", index, got)
		}
		if got := call.Query.Get("platform"); got != platformModeAll {
			t.Fatalf("chunk %d platform = %q", index, got)
		}
		ids := strings.Split(call.Query.Get("extensionIds"), ",")
		if index == 0 && len(ids) != 100 {
			t.Fatalf("first chunk has %d ids, want 100", len(ids))
		}
		if index == 1 && len(ids) != 50 {
			t.Fatalf("second chunk has %d ids, want 50", len(ids))
		}
		if !sortedUnique(ids) {
			t.Fatalf("chunk %d ids are not sorted/unique: %v", index, ids)
		}
	}
}

func sortedUnique(values []string) bool {
	for index, value := range values {
		if index > 0 && values[index-1] >= value {
			return false
		}
	}
	return true
}

func TestUpdateSurfaceLocaleCopy(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusOK, surfaceCatalog(
			surfaceCatalogItem("markdown", "sforum.markdown", "plugin", "1.5.0"),
		), nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	zh, failure := renderSurface(t, server, "zh-CN",
		surfaceResourceInput("sforum.markdown", "plugin", "1.0.0", "", ""))
	if failure != nil {
		t.Fatalf("zh render failed: %v", failure)
	}
	if zh["title"] != "商城更新" || surfaceCells(t, zh)["sforum.markdown"] != "商城有新版 v1.5.0" {
		t.Fatalf("zh copy = %v / %v", zh["title"], surfaceCells(t, zh))
	}

	en, failure := renderSurface(t, server, "en-US",
		surfaceResourceInput("sforum.markdown", "plugin", "1.0.0", "", ""))
	if failure != nil {
		t.Fatalf("en render failed: %v", failure)
	}
	if en["title"] != "Store updates" || surfaceCells(t, en)["sforum.markdown"] != "Update in store v1.5.0" {
		t.Fatalf("en copy = %v / %v", en["title"], surfaceCells(t, en))
	}
}

func TestUpdateSurfaceDeadlineIsAFailure(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		time.Sleep(200 * time.Millisecond)
		writeUpstreamJSON(t, w, http.StatusOK, surfaceCatalog(), nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, failure := server.renderUpdateSurface(
		ctx, updateSurfaceDeclarations[0], emptyRequestContext(),
		surfaceInput("zh-CN", surfaceResourceInput("sforum.markdown", "plugin", "1.0.0", "", "")),
	)
	if failure == nil || failure.code != protocolwire.ErrorCode_ERROR_CODE_DEADLINE_EXCEEDED {
		t.Fatalf("deadline must be a typed failure, got %+v", failure)
	}
}

// 覆写 InvokeHook 会 shadow SDK 的 validateRuntimeContext；这两条测试守住
// 「没有握手身份就绝不进入业务代码」。
func TestInvokeHookRequiresContextAndRuntimeIdentity(t *testing.T) {
	server := newTestStoreServer(t, storeSettings{Channel: channelStable})

	missingContext, err := server.InvokeHook(context.Background(), &pluginwire.HookRequest{
		HookId: "sforum.store.admin.updates.plugins", HookKind: adminSurfaceHookKind,
		HookName: updateSurfaceHandler, ContractVersion: "sforum.store.admin.updates.plugins@3",
	})
	if err != nil {
		t.Fatalf("invoke without context: %v", err)
	}
	if missingContext.GetAccepted() ||
		missingContext.GetError().GetCode() != protocolwire.ErrorCode_ERROR_CODE_INVALID_ARGUMENT {
		t.Fatalf("missing context response = %+v", missingContext)
	}

	// 服务未握手（测试里从不启动 go-plugin 运行时）：Health 必须拒绝。
	// 带上扩展身份是为了走到 validateRuntimeContext 的 `!s.started` 分支，
	// 证明覆写后的 InvokeHook 没有绕过运行时校验。
	unstarted, err := server.InvokeHook(context.Background(), &pluginwire.HookRequest{
		Context: &protocolwire.RequestContext{
			RequestId: "test-hook",
			Extension: &protocolwire.ExtensionIdentity{
				ExtensionId:      "sforum.store",
				ExtensionVersion: "0.1.0",
				ArtifactDigest:   strings.Repeat("a", 64),
				TrustGrantId:     "grant",
				RuntimeEpoch:     1,
				InstanceId:       "instance",
			},
		},
		HookId:  "sforum.store.admin.updates.plugins", HookKind: adminSurfaceHookKind,
		HookName: updateSurfaceHandler, ContractVersion: "sforum.store.admin.updates.plugins@3",
	})
	if err != nil {
		t.Fatalf("invoke without handshake: %v", err)
	}
	if unstarted.GetAccepted() ||
		unstarted.GetError().GetCode() != protocolwire.ErrorCode_ERROR_CODE_STALE_RUNTIME {
		t.Fatalf("unstarted runtime response = %+v", unstarted)
	}
}

// 覆写 InvokeHook 只接管 admin_surface：其它 hook 家族必须回落到 SDK 的
// validateRuntimeContext 与注册表分发，否则以后新增 hook 会被这里挡成「未声明」。
// 回落路径先撞上身份校验，因此看到的是 protocol.* 而不是本文件的 surface.* reason。
func TestInvokeHookLeavesOtherHookFamiliesToSDK(t *testing.T) {
	server := newTestStoreServer(t, storeSettings{Channel: channelStable})
	response, err := server.InvokeHook(context.Background(), &pluginwire.HookRequest{
		Context:         &protocolwire.RequestContext{RequestId: "test-observe"},
		HookId:          "sforum.store.observe.example",
		HookKind:        "observe",
		HookName:        "sforum.store.observe.example",
		ContractVersion: "sforum.store.observe.example@1",
	})
	if err != nil {
		t.Fatalf("fallback returned a transport error: %v", err)
	}
	reason := response.GetError().GetReason()
	if reason != "protocol.identity_required" && reason != "protocol.stale_runtime" {
		t.Fatalf("fallback did not reach the SDK runtime check: %+v", response)
	}
	if response.GetAccepted() {
		t.Fatalf("fallback must not be accepted: %+v", response)
	}
}

func TestUpdateSurfaceByIDRejectsUnknownSurface(t *testing.T) {
	if _, ok := updateSurfaceByID("sforum.store.admin.updates.unknown"); ok {
		t.Fatal("unknown surface id was accepted")
	}
	if declaration, ok := updateSurfaceByID("sforum.store.admin.updates.themes"); !ok ||
		declaration.placementID != "core.component.page.admin.extensions.themes" {
		t.Fatalf("themes declaration = %+v ok=%v", declaration, ok)
	}
}
