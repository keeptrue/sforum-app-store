package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/Masterminds/semver/v3"

	pluginv2 "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2"
	pluginwire "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2/gen/sforum/plugin/v2"
	protocolwire "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2/gen/sforum/protocol/v2"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// 更新徽章是一个 Admin Surface `list_column`：宿主在扩展管理三页把当前页的资源发
// 过来，插件只回答「哪些扩展在商城里比已装/已暂存的版本更新」，并为每条徽章附上
// 商城详情页的同源深链。可升级判断与目录卡片共用 mapping.go 的 updateAvailable，
// 两处不会各说各话。
//
// 这条路径不新增 Core 契约：声明、props/result schema、handler 都在本包清单里，
// 宿主只按通用 Admin Surface 调用。
const (
	adminSurfaceHookKind = "admin_surface"

	updateSurfaceHandler      = "sforum.store.admin.updates"
	updateSurfacePropsSchema  = "sforum.store.admin.updates.props@1"
	updateSurfaceResultSchema = "sforum.store.admin.updates.result@1"

	// 5s 是这张 surface 的全部预算：超时按失败处理，不返回半真半假的结果。
	updateSurfaceTimeout      = 5 * time.Second
	updateSurfaceChunkSize    = 100
	updateSurfaceMaxResources = 1000

	surfaceLocaleChinese = "zh"
	surfaceLocaleEnglish = "en"
)

// extensionIDPattern 对齐商城目录契约的扩展 ID 语法。不合法的资源在本地跳过：
// 把一个坏 ID 发给上游只会让整批 400，连累同页其它扩展。
var extensionIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,159}$`)

// updateSurfaceDeclaration 是一条 list_column 的精确声明。宿主按 id 定位，
// ContractVersion 必须与清单里的 `id@N` 逐字一致；改清单里的任何字段（含 label 文案）
// 都要同时抬这里的版本号，Core 的 validateAdminSurfaceUpgrade 会整结构体比较。
type updateSurfaceDeclaration struct {
	id                       string
	contractVersion          string
	placementID              string
	placementContractVersion string
}

// 三个页面共用同一个 handler 与同一对 schema：判定逻辑完全相同，差别只有 placement。
var updateSurfaceDeclarations = []updateSurfaceDeclaration{
	{
		id:                       "sforum.store.admin.updates.plugins",
		contractVersion:          "sforum.store.admin.updates.plugins@3",
		placementID:              "core.component.page.admin.extensions.plugins",
		placementContractVersion: "sforum.component.page.admin.extensions.plugins@1",
	},
	{
		id:                       "sforum.store.admin.updates.themes",
		contractVersion:          "sforum.store.admin.updates.themes@3",
		placementID:              "core.component.page.admin.extensions.themes",
		placementContractVersion: "sforum.component.page.admin.extensions.themes@1",
	},
	{
		id:                       "sforum.store.admin.updates.overview",
		contractVersion:          "sforum.store.admin.updates.overview@3",
		placementID:              "core.component.page.admin.extensions",
		placementContractVersion: "sforum.component.page.admin.extensions@1",
	},
}

func updateSurfaceByID(id string) (updateSurfaceDeclaration, bool) {
	for _, declaration := range updateSurfaceDeclarations {
		if declaration.id == id {
			return declaration, true
		}
	}
	return updateSurfaceDeclaration{}, false
}

// InvokeHook 覆盖 SDK 的默认分发：默认实现只查 HookRegistry，而本插件的三条
// surface 共用一个 handler，声明在清单里而不是运行期注册。
//
// 覆盖会 shadow SDK 的 validateRuntimeContext，所以开头必须先调一次 Health
// （它内部就是那条校验）：运行时身份不匹配时绝不进入业务代码。
func (s *storeServer) InvokeHook(ctx context.Context, request *pluginwire.HookRequest) (*pluginwire.HookResponse, error) {
	response := &pluginwire.HookResponse{Context: hookResponseContext(request), Accepted: false}
	if request == nil || request.GetContext() == nil {
		return rejectSurface(response, surfaceError{
			code:    protocolwire.ErrorCode_ERROR_CODE_INVALID_ARGUMENT,
			reason:  "sforum.store.surface.context_required",
			message: "The admin surface request context is required.",
		}), nil
	}
	health, err := s.Server.Health(ctx, &protocolwire.HealthRequest{Context: request.GetContext()})
	if err != nil {
		return nil, err
	}
	if health.GetError() != nil {
		response.Error = health.GetError()
		return response, nil
	}

	if request.GetHookKind() != adminSurfaceHookKind {
		// 覆写只接管 admin_surface：其它 hook 家族交回 SDK 的注册表分发，
		// 否则以后新增 hook 会被这里挡成「未声明」。
		return s.Server.InvokeHook(ctx, request)
	}
	declaration, ok := updateSurfaceByID(request.GetHookId())
	if !ok {
		return rejectSurface(response, surfaceError{
			code:    protocolwire.ErrorCode_ERROR_CODE_NOT_FOUND,
			reason:  "sforum.store.surface.not_declared",
			message: "The requested admin surface is not declared by sforum.store.",
		}), nil
	}
	if request.GetHookName() != updateSurfaceHandler ||
		request.GetContractVersion() != declaration.contractVersion ||
		!pluginv2.DocumentMatchesSchema(request.GetPayload(), updateSurfacePropsSchema) {
		return rejectSurface(response, surfaceError{
			code:    protocolwire.ErrorCode_ERROR_CODE_INVALID_ARGUMENT,
			reason:  "sforum.store.surface.contract_mismatch",
			message: "The admin surface request does not match its exact declaration.",
		}), nil
	}

	input := map[string]any{}
	if request.GetPayload().GetValue() != nil {
		input = request.GetPayload().GetValue().AsMap()
	}
	result, failure := s.renderUpdateSurface(ctx, declaration, request.GetContext(), input)
	if failure != nil {
		return rejectSurface(response, *failure), nil
	}
	document, err := newDocument(updateSurfaceResultSchema, result)
	if err != nil {
		return nil, err
	}
	response.Accepted = true
	response.Result = document
	return response, nil
}

// surfaceError 是一次 surface 失败在本插件里的完整表达。Reason 是稳定标识，
// Message 是给管理员看的一句话：两者都不含商城地址、设置值或 token。
type surfaceError struct {
	code      protocolwire.ErrorCode
	reason    string
	message   string
	retryable bool
}

func (e surfaceError) Error() string { return e.reason }

func rejectSurface(response *pluginwire.HookResponse, failure surfaceError) *pluginwire.HookResponse {
	response.Accepted = false
	response.Result = nil
	response.Patch = nil
	response.Error = &protocolwire.ErrorDetail{
		Code:      failure.code,
		Reason:    failure.reason,
		Message:   failure.message,
		Retryable: failure.retryable,
	}
	return response
}

// upstreamStatus 取上游 HTTP 状态码；非 HTTP 失败（传输、解码、超时）返回 0。
func upstreamStatus(err error) int {
	var upstream *upstreamError
	if errors.As(err, &upstream) {
		return upstream.status
	}
	return 0
}

// surfaceUpstreamFailure 把上游失败翻译成 Core 能展示的 typed error。
//
// 4xx 是确定性答案：401/403 是地址或凭据问题，404 是目录路径不对，429 是限流。
// 它们不该被静默成「没有更新」，也不该标成可重试；只有 5xx 与传输失败才是
// 暂时故障。400 在调用点单独处理（旧商城不认识 extensionIds）。
func surfaceUpstreamFailure(err error) *surfaceError {
	switch status := upstreamStatus(err); {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return &surfaceError{
			code:    protocolwire.ErrorCode_ERROR_CODE_UNAVAILABLE,
			reason:  "sforum.store.surface.upstream_rejected",
			message: "商城拒绝了这次更新检查，请确认商城地址与访问权限。",
		}
	case status == http.StatusNotFound:
		return &surfaceError{
			code:    protocolwire.ErrorCode_ERROR_CODE_UNAVAILABLE,
			reason:  "sforum.store.surface.upstream_rejected",
			message: "商城的目录接口不存在，请确认商城地址与目录路径。",
		}
	case status == http.StatusTooManyRequests:
		return &surfaceError{
			code:      protocolwire.ErrorCode_ERROR_CODE_UNAVAILABLE,
			reason:    "sforum.store.surface.upstream_unavailable",
			message:   "商城请求过于频繁，请稍后重试。",
			retryable: true,
		}
	case status >= 400 && status < 500:
		return &surfaceError{
			code:    protocolwire.ErrorCode_ERROR_CODE_UNAVAILABLE,
			reason:  "sforum.store.surface.upstream_rejected",
			message: "商城拒绝了这次更新检查。",
		}
	default:
		return &surfaceError{
			code:      protocolwire.ErrorCode_ERROR_CODE_UNAVAILABLE,
			reason:    "sforum.store.surface.upstream_unavailable",
			message:   "商城暂时不可用，更新检查未完成。",
			retryable: true,
		}
	}
}

// renderUpdateSurface 是这条 surface 的全部业务：读设置 → 整理资源 → 按 100 个一组
// 查商城 → 生成 cells/links。任何一组失败都整体失败（fail closed），不返回半张表。
func (s *storeServer) renderUpdateSurface(
	ctx context.Context,
	declaration updateSurfaceDeclaration,
	requestCtx *protocolwire.RequestContext,
	input map[string]any,
) (map[string]any, *surfaceError) {
	locale := normalizeSurfaceLocale(stringValue(input["locale"]))
	result := map[string]any{
		"title": updateSurfaceTitle(locale),
		"tone":  "warning",
		"icon":  "i-lucide-arrow-up-circle",
		"cells": map[string]any{},
		"links": map[string]any{},
	}

	settings := s.settings(ctx, requestCtx)
	if !settings.configured() {
		// 没配商城地址不是故障：这张 surface 只是没有话可说，页面照常显示扩展列表。
		return result, nil
	}

	resources := surfaceResources(input)
	if len(resources) == 0 {
		return result, nil
	}

	ctx, cancel := context.WithTimeout(ctx, updateSurfaceTimeout)
	defer cancel()

	byID := make(map[string]surfaceResource, len(resources))
	for _, resource := range resources {
		byID[resource.id] = resource
	}
	build := s.hostBuildSnapshot()
	cells := map[string]any{}
	links := map[string]any{}

	for _, chunk := range chunkSurfaceIDs(resources) {
		fetched, err := s.store.catalog(ctx, settings.CatalogBaseURL, catalogQuery{
			Channel:      settings.Channel,
			ExtensionIDs: chunk,
			Limit:        updateSurfaceChunkSize,
			// 更新判断只看「有没有更新的版本」，不能让宿主版本/架构把候选藏掉。
			Compat:      compatModeAll,
			PlatformAll: true,
			SForum:      build.CoreVersion,
			SForumBuild: build.BuildVersion,
		})
		if err != nil {
			if ctx.Err() != nil {
				log.Printf("%s: surface deadline exceeded (%s)", declaration.id, upstreamFailureReason(err))
				return nil, &surfaceError{
					code:      protocolwire.ErrorCode_ERROR_CODE_DEADLINE_EXCEEDED,
					reason:    "sforum.store.surface.timeout",
					message:   "商城响应超时，更新检查未完成。",
					retryable: true,
				}
			}
			// 只有 400 才是「旧商城不认识 extensionIds」的确定性答案：空结果比编一个
			// 徽章诚实，也比整页报错有用。其余 4xx 是权限、地址或限流问题，必须如实
			// 上报——把它们静默成「没有更新」会藏住真正需要运维介入的故障。
			if upstreamStatus(err) == http.StatusBadRequest {
				log.Printf("%s: catalog rejected extensionIds (%s); no badges", declaration.id, upstreamFailureReason(err))
				return result, nil
			}
			log.Printf("%s: surface upstream failed (%s)", declaration.id, upstreamFailureReason(err))
			return nil, surfaceUpstreamFailure(err)
		}
		if fetched.stale {
			// storeClient 在上游故障时会用旧缓存兜底。更新徽章不能把旧快照当成
			// 本次结果：宁可让管理员看到可重试的提示，也不给一个过期的「已是最新」。
			log.Printf("%s: surface upstream stale; no badges", declaration.id)
			return nil, &surfaceError{
				code:      protocolwire.ErrorCode_ERROR_CODE_UNAVAILABLE,
				reason:    "sforum.store.surface.upstream_unavailable",
				message:   "商城暂时不可用，更新检查未完成。",
				retryable: true,
			}
		}

		for _, item := range fetched.page.Items {
			resource, known := byID[strings.TrimSpace(item.ExtensionID)]
			if !known || strings.TrimSpace(item.Kind) != resource.kind {
				continue
			}
			slug := strings.TrimSpace(item.Slug)
			latest := strings.TrimSpace(item.LatestVersion)
			if !slugPattern.MatchString(slug) || latest == "" || !updateAvailable(resource.version, latest) {
				continue
			}
			cells[resource.id] = updateBadgeText(locale, latest)
			links[resource.id] = updateSurfaceLink(slug)
		}
	}

	result["cells"] = cells
	result["links"] = links
	return result, nil
}

// surfaceResource 是本地视角下的一条已装扩展。version 已经是 active 与 staged
// 里较高的可解析版本：暂存了更新的版本时，它已经「拿到手」，不该再提示更新。
type surfaceResource struct {
	id      string
	kind    string
	version string
}

func surfaceResources(input map[string]any) []surfaceResource {
	raw, _ := input["resources"].([]any)
	byID := make(map[string]surfaceResource, len(raw))
	for _, entry := range raw {
		if len(byID) >= updateSurfaceMaxResources {
			break
		}
		resource, _ := entry.(map[string]any)
		id := strings.TrimSpace(stringValue(resource["id"]))
		if !extensionIDPattern.MatchString(id) {
			continue
		}
		attributes, _ := resource["attributes"].(map[string]any)
		if attributes == nil {
			continue
		}
		// 内置扩展跟着 Core 发布，商城不参与它的升级。
		if strings.EqualFold(strings.TrimSpace(stringValue(attributes["source"])), "builtin") {
			continue
		}
		kind := strings.TrimSpace(stringValue(attributes["type"]))
		if kind != "plugin" && kind != "theme" {
			continue
		}
		version := higherVersion(stringValue(attributes["version"]), stringValue(attributes["stagedVersion"]))
		if version == "" {
			continue
		}
		if _, exists := byID[id]; exists {
			continue
		}
		byID[id] = surfaceResource{id: id, kind: kind, version: version}
	}

	result := make([]surfaceResource, 0, len(byID))
	for _, resource := range byID {
		result = append(result, resource)
	}
	sort.Slice(result, func(left, right int) bool { return result[left].id < result[right].id })
	return result
}

// higherVersion 返回两个候选里较高的可解析版本；两个都解析不了时返回空串
// （调用方据此跳过——拿不到版本就没有「更新」可言）。
func higherVersion(active, staged string) string {
	best := ""
	var bestParsed *semver.Version
	for _, candidate := range []string{active, staged} {
		text := strings.TrimSpace(candidate)
		if text == "" {
			continue
		}
		parsed, err := semver.NewVersion(text)
		if err != nil {
			continue
		}
		if bestParsed == nil || parsed.GreaterThan(bestParsed) {
			best, bestParsed = text, parsed
		}
	}
	return best
}

func chunkSurfaceIDs(resources []surfaceResource) [][]string {
	chunks := make([][]string, 0, (len(resources)+updateSurfaceChunkSize-1)/updateSurfaceChunkSize)
	for start := 0; start < len(resources); start += updateSurfaceChunkSize {
		end := start + updateSurfaceChunkSize
		if end > len(resources) {
			end = len(resources)
		}
		chunk := make([]string, 0, end-start)
		for _, resource := range resources[start:end] {
			chunk = append(chunk, resource.id)
		}
		chunks = append(chunks, chunk)
	}
	return chunks
}

// updateSurfaceLink 是商城管理页的深链：产品 slug 只出现在查询串里，且经过
// QueryEscape，因此不会改变路径本身。
func updateSurfaceLink(slug string) string {
	return "/extensions/sforum.store/pages/catalog?product=" + url.QueryEscape(slug)
}

func normalizeSurfaceLocale(raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	if strings.HasPrefix(value, surfaceLocaleEnglish) {
		return surfaceLocaleEnglish
	}
	return surfaceLocaleChinese
}

// 这两条文案刻意与 Core 的三态更新语义（可升级 / 重启后生效 / 激活后生效）区分开：
// 商城只说「商城有新版」，不替宿主断言当前实例能升到哪一档。
func updateSurfaceTitle(locale string) string {
	if locale == surfaceLocaleEnglish {
		return "Store updates"
	}
	return "商城更新"
}

func updateBadgeText(locale, version string) string {
	if locale == surfaceLocaleEnglish {
		return "Update in store v" + version
	}
	return "商城有新版 v" + version
}

func hookResponseContext(request *pluginwire.HookRequest) *protocolwire.ResponseContext {
	result := &protocolwire.ResponseContext{ServerTime: timestamppb.New(time.Now().UTC())}
	if request == nil || request.GetContext() == nil {
		return result
	}
	result.RequestId = request.GetContext().GetRequestId()
	if trace := request.GetContext().GetTrace(); trace != nil {
		result.Trace = proto.Clone(trace).(*protocolwire.TraceContext)
	}
	if identity := request.GetContext().GetExtension(); identity != nil {
		result.Extension = proto.Clone(identity).(*protocolwire.ExtensionIdentity)
	}
	return result
}
