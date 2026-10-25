package main

import (
	"net/url"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// 上游（商城 service/）的读模型。字段与 contracts/store-api.yaml 对齐，
// 但不加 DisallowUnknownFields：商城新增字段时插件不该跟着崩。
type upstreamCompatibility struct {
	Status     string `json:"status"`
	Estimated  bool   `json:"estimated"`
	Constraint string `json:"constraint"`
}

type upstreamPlatform struct {
	OS   string `json:"os"`
	Arch string `json:"arch"`
}

// upstreamReadme 是 ProductDetail.readme：商城把仓库 README 渲染并消毒后的结果。
// 商城还没读到 README 时整个字段是 null，所以这里必须用指针区分「null」与「空对象」。
type upstreamReadme struct {
	HTML      string  `json:"html"`
	SourceURL string  `json:"sourceUrl"`
	SHA       *string `json:"sha"`
	FetchedAt string  `json:"fetchedAt"`
	ByteSize  *int64  `json:"byteSize"`
}

type upstreamAsset struct {
	OS       string `json:"os"`
	Arch     string `json:"arch"`
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256"`
}

type upstreamRelease struct {
	Version       string          `json:"version"`
	Channel       string          `json:"channel"`
	PublishedAt   string          `json:"publishedAt"`
	SForumVersion string          `json:"sforumVersion"`
	Status        string          `json:"status"`
	Digest        string          `json:"digest"`
	Notes         *string         `json:"notes"`
	Capabilities  []string        `json:"capabilities"`
	Assets        []upstreamAsset `json:"assets"`
}

// upstreamSummary 是目录项与详情共有的字段集合；详情在它之上追加
// readme / repoUrl / releases。产品介绍只有 readme 一个来源，没有手写正文与截图。
type upstreamSummary struct {
	Slug          string                 `json:"slug"`
	ExtensionID   string                 `json:"extensionId"`
	Name          string                 `json:"name"`
	Kind          string                 `json:"kind"`
	Summary       string                 `json:"summary"`
	Category      *string                `json:"category"`
	Tags          []string               `json:"tags"`
	Owner         *string                `json:"owner"`
	IconURL       *string                `json:"iconUrl"`
	LatestVersion string                 `json:"latestVersion"`
	SForumVersion string                 `json:"sforumVersion"`
	UpdatedAt     string                 `json:"updatedAt"`
	Platforms     []upstreamPlatform     `json:"platforms"`
	Compatibility *upstreamCompatibility `json:"compatibility"`
}

type upstreamCatalog struct {
	Items         []upstreamSummary      `json:"items"`
	Total         int                    `json:"total"`
	NextCursor    *string                `json:"nextCursor"`
	Compatibility *upstreamCompatibility `json:"compatibility"`
}

type upstreamProduct struct {
	upstreamSummary
	Readme   *upstreamReadme   `json:"readme"`
	RepoURL  *string           `json:"repoUrl"`
	Releases []upstreamRelease `json:"releases"`
}

// downloadURLRequest 是 POST /api/v1/download-urls 的请求体。字段名用商城的
// 契约（product 而不是 slug）；version 省略时由商城取最新 stable 版本。
type downloadURLRequest struct {
	Product string `json:"product"`
	Version string `json:"version,omitempty"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
}

// upstreamDownloadURL 是商城签发的下载链接；只这四个字段会出现在插件响应里。
type upstreamDownloadURL struct {
	URL       string `json:"url"`
	SHA256    string `json:"sha256"`
	Size      int64  `json:"size"`
	ExpiresAt string `json:"expiresAt"`
}

var (
	sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// validate 保证只把形状正确的签名链接交给管理页：宿主随后会拿 sha256 校验下载包，
// 这里少一个字段就是一次装不上的安装。
func (d upstreamDownloadURL) validate() error {
	parsed, err := url.Parse(strings.TrimSpace(d.URL))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return &upstreamError{category: errUpstreamFailure, kind: "invalid_download_url"}
	}
	if !sha256Pattern.MatchString(d.SHA256) || d.Size < 0 || strings.TrimSpace(d.ExpiresAt) == "" {
		return &upstreamError{category: errUpstreamFailure, kind: "invalid_download_url"}
	}
	if _, err := time.Parse(time.RFC3339, d.ExpiresAt); err != nil {
		return &upstreamError{category: errUpstreamFailure, kind: "invalid_download_url"}
	}
	return nil
}

func downloadURLValues(result upstreamDownloadURL) map[string]any {
	return map[string]any{
		"url":       result.URL,
		"sha256":    result.SHA256,
		"size":      result.Size,
		"expiresAt": result.ExpiresAt,
	}
}

const (
	channelStable = "stable"
	channelBeta   = "beta"

	compatibilityCompatible   = "compatible"
	compatibilityIncompatible = "incompatible"
	compatibilityUnknown      = "unknown"

	kindPlugin = "plugin"
	kindTheme  = "theme"
)

func validChannel(value string) bool {
	return value == channelStable || value == channelBeta
}

func validKind(value string) bool {
	return value == kindPlugin || value == kindTheme
}

// catalogResponseValues 从上游页生成 catalog.response DTO。baseURL 是商城基址，
// 用来把 iconUrl 拼成绝对地址。
// 返回 dropped：形状不合法的条目数量，handler 只把它写进日志。
func catalogResponseValues(result catalogResult, baseURL string) (map[string]any, int) {
	items := make([]any, 0, len(result.page.Items))
	dropped := 0
	for _, item := range result.page.Items {
		values, ok := catalogItemValues(item, baseURL)
		if !ok {
			dropped++
			continue
		}
		items = append(items, values)
	}

	values := map[string]any{
		"items":         items,
		"total":         max(result.page.Total, 0),
		"nextCursor":    nil,
		"compatibility": compatibilityValues(result.page.Compatibility),
		"target": map[string]any{
			"os":   runtime.GOOS,
			"arch": runtime.GOARCH,
		},
		"stale":     result.stale,
		"fetchedAt": fetchedAtString(result.fetchedAt),
	}
	if cursor := optionalText(result.page.NextCursor); cursor != "" {
		values["nextCursor"] = cursor
	}
	return values, dropped
}

// catalogItemValues 只映射 catalog.response 定义过的字段：tags / owner 这类
// 上游字段一律丢弃，页面看到的是稳定形状。
func catalogItemValues(item upstreamSummary, baseURL string) (map[string]any, bool) {
	if !validKind(item.Kind) || strings.TrimSpace(item.Slug) == "" {
		return nil, false
	}
	values := map[string]any{
		"slug":          item.Slug,
		"extensionId":   item.ExtensionID,
		"name":          item.Name,
		"kind":          item.Kind,
		"summary":       item.Summary,
		"category":      nullableText(item.Category),
		"iconUrl":       absoluteAssetURL(baseURL, item.IconURL),
		"latestVersion": item.LatestVersion,
		// 清单里的宿主约束，原样透出：目录行展示它，判定仍由 core 在安装时做。
		"sforumVersion": item.SForumVersion,
		"platforms":     platformValues(item.Platforms),
		"compatibility": compatibilityValues(item.Compatibility),
	}
	if updatedAt := strings.TrimSpace(item.UpdatedAt); updatedAt != "" {
		values["updatedAt"] = updatedAt
	}
	return values, true
}

// absoluteAssetURL 把商城给的相对资产地址拼成绝对地址。
//
// 面板里的 <img> 需要绝对地址：/api/assets/<sha> 是商城自己的路径，相对地址会落到论坛
// 域名上。这里刻意不做图片代理 —— 商城不进论坛请求链路，图片是公开的内容寻址资源，由
// 浏览器直连商城。基址来自设置且已被限定为 https，拼不出来就返回 nil，页面退回字母块。
// 返回值是 any（nil 或 string）：路由正文会被编码成 protobuf Struct，*string 不是合法值。
func absoluteAssetURL(baseURL string, path *string) any {
	if path == nil {
		return nil
	}
	p := strings.TrimSpace(*path)
	if p == "" {
		return nil
	}
	if strings.HasPrefix(p, "https://") || strings.HasPrefix(p, "http://") {
		return p
	}
	base, err := url.Parse(baseURL)
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil
	}
	ref, err := url.Parse(p)
	if err != nil {
		return nil
	}
	return base.ResolveReference(ref).String()
}

// productResponseValues 生成 product.response DTO。kind 不合法时返回错误：
// 详情页没有条目可丢，契约被破坏就是上游故障（502），不能伪造一个 kind。
func productResponseValues(result productResult, baseURL string) (map[string]any, int, error) {
	if !validKind(result.product.Kind) || strings.TrimSpace(result.product.Slug) == "" {
		return nil, 0, &upstreamError{category: errUpstreamFailure, kind: "invalid_product"}
	}

	releases := make([]any, 0, len(result.product.Releases))
	dropped := 0
	for _, release := range result.product.Releases {
		values, ok := releaseValues(release)
		if !ok {
			dropped++
			continue
		}
		releases = append(releases, values)
	}

	product := map[string]any{
		"slug":        result.product.Slug,
		"extensionId": result.product.ExtensionID,
		"name":        result.product.Name,
		"kind":        result.product.Kind,
		"summary":     result.product.Summary,
		"readme":      readmeValues(result.product.Readme),
		"category":    nullableText(result.product.Category),
		"iconUrl":     absoluteAssetURL(baseURL, result.product.IconURL),
		"repoUrl":     nullableText(result.product.RepoURL),
		"platforms":   platformValues(result.product.Platforms),
		"releases":    releases,
	}
	if latest := strings.TrimSpace(result.product.LatestVersion); latest != "" {
		product["latestVersion"] = latest
	}
	return map[string]any{
		"product":   product,
		"stale":     result.stale,
		"fetchedAt": fetchedAtString(result.fetchedAt),
	}, dropped, nil
}

func releaseValues(release upstreamRelease) (map[string]any, bool) {
	if strings.TrimSpace(release.Version) == "" || !validChannel(release.Channel) {
		return nil, false
	}
	assets := make([]any, 0, len(release.Assets))
	for _, asset := range release.Assets {
		if values, ok := assetValues(asset); ok {
			assets = append(assets, values)
		}
	}
	values := map[string]any{
		"version":       release.Version,
		"channel":       release.Channel,
		"publishedAt":   release.PublishedAt,
		"sforumVersion": release.SForumVersion,
		"status":        release.Status,
		"notes":         nullableText(release.Notes),
		"capabilities":  stringValues(release.Capabilities),
		"assets":        assets,
	}
	if digest := strings.TrimSpace(release.Digest); digest != "" {
		values["digest"] = digest
	}
	return values, true
}

func assetValues(asset upstreamAsset) (map[string]any, bool) {
	if strings.TrimSpace(asset.OS) == "" || strings.TrimSpace(asset.Arch) == "" ||
		strings.TrimSpace(asset.Filename) == "" {
		return nil, false
	}
	return map[string]any{
		"os":       asset.OS,
		"arch":     asset.Arch,
		"filename": asset.Filename,
		"size":     max(asset.Size, 0),
		"sha256":   asset.SHA256,
	}, true
}

// compatibilityValues 是 §6.2 的落点：插件从不发送宿主版本，所以上游缺字段、
// 给了未知枚举都统一报 unknown + estimated=false，绝不自造兼容结论。
func compatibilityValues(compat *upstreamCompatibility) map[string]any {
	if compat == nil {
		return map[string]any{"status": compatibilityUnknown, "estimated": false}
	}
	switch compat.Status {
	case compatibilityCompatible, compatibilityIncompatible:
		values := map[string]any{"status": compat.Status, "estimated": compat.Estimated}
		if constraint := strings.TrimSpace(compat.Constraint); constraint != "" {
			values["constraint"] = constraint
		}
		return values
	case compatibilityUnknown:
		return map[string]any{"status": compatibilityUnknown, "estimated": compat.Estimated}
	default:
		return map[string]any{"status": compatibilityUnknown, "estimated": false}
	}
}

func platformValues(platforms []upstreamPlatform) []any {
	values := make([]any, 0, len(platforms))
	for _, platform := range platforms {
		if strings.TrimSpace(platform.OS) == "" || strings.TrimSpace(platform.Arch) == "" {
			continue
		}
		values = append(values, map[string]any{"os": platform.OS, "arch": platform.Arch})
	}
	return values
}

// readmeValues 映射 README 的渲染结果。html / sourceUrl / fetchedAt 是契约必填项：
// 缺任何一项都按「商城还没读到」处理，返回 null，页面据此显示占位文案，而不是
// 渲染半截内容。html 由商城服务端白名单消毒，插件只透传，不做二次渲染或改写。
func readmeValues(readme *upstreamReadme) any {
	if readme == nil {
		return nil
	}
	sourceURL := strings.TrimSpace(readme.SourceURL)
	fetchedAt := strings.TrimSpace(readme.FetchedAt)
	if strings.TrimSpace(readme.HTML) == "" || sourceURL == "" || fetchedAt == "" {
		return nil
	}
	values := map[string]any{
		"html":      readme.HTML,
		"sourceUrl": sourceURL,
		"sha":       nullableText(readme.SHA),
		"fetchedAt": fetchedAt,
	}
	if readme.ByteSize != nil && *readme.ByteSize >= 0 {
		values["byteSize"] = *readme.ByteSize
	}
	return values
}

func stringValues(values []string) []any {
	result := make([]any, 0, len(values))
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

// nullableText 把上游的可空字段映射成显式 null：页面按 key 存在性分支比按
// undefined 猜更稳。
func nullableText(value *string) any {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func optionalText(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func fetchedAtString(fetchedAt time.Time) string {
	return fetchedAt.UTC().Format(time.RFC3339)
}
