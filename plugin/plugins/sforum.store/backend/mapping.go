package main

import (
	"net/url"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/Masterminds/semver/v3"
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
	Version       string `json:"version"`
	Channel       string `json:"channel"`
	PublishedAt   string `json:"publishedAt"`
	SForumVersion string `json:"sforumVersion"`
	Status        string `json:"status"`
	Digest        string `json:"digest"`
	// Notes 是 GitHub Release 原文（Markdown 源），NotesHTML 是商城渲染并消毒后的 HTML。
	// 两者都缺表示这个版本没有正文；页面优先用 NotesHTML，缺了才退回 Notes 的纯文本。
	Notes        *string         `json:"notes"`
	NotesHTML    *string         `json:"notesHtml"`
	Capabilities []string        `json:"capabilities"`
	Assets       []upstreamAsset `json:"assets"`
}

// upstreamAuthor 是 ProductDetail.author：一半来自论坛账号，一半来自绑定仓库的
// GitHub 账号（installation 的 account.login）。两半各自可为空，插件不互相替补。
type upstreamAuthor struct {
	Username    *string `json:"username"`
	DisplayName *string `json:"displayName"`
	AvatarURL   *string `json:"avatarUrl"`
	// ProfileURL 是商城按 issuer 基址拼出的论坛个人主页地址。插件不再自己拼：它没有论坛
	// 域名（管理页桥不带站点地址），拿不到就不给链接，绝不让用户名指向一个猜出来的路径。
	ProfileURL *string         `json:"profileUrl"`
	Github     *upstreamGithub `json:"github"`
}

type upstreamGithub struct {
	Login string `json:"login"`
	// URL 上游会给，但插件只认 login 并在本地重新拼：地址只有一个合法形态
	// （https://github.com/<login>），接受上游整串等于把「链接指向哪里」交给数据。
	URL string `json:"url"`
}

// upstreamSummary 是目录项与详情共有的字段集合；详情在它之上追加
// readme / repoUrl / releases。产品介绍只有 readme 一个来源，没有手写正文与截图。
type upstreamSummary struct {
	Slug           string             `json:"slug"`
	ExtensionID    string             `json:"extensionId"`
	Name           string             `json:"name"`
	Kind           string             `json:"kind"`
	Summary        string             `json:"summary"`
	Category       *string            `json:"category"`
	Tags           []string           `json:"tags"`
	Owner          *string            `json:"owner"`
	IconURL        *string            `json:"iconUrl"`
	SocialImageURL *string            `json:"socialImageUrl"`
	LatestVersion  string             `json:"latestVersion"`
	SForumVersion  string             `json:"sforumVersion"`
	UpdatedAt      string             `json:"updatedAt"`
	Platforms      []upstreamPlatform `json:"platforms"`
	// LatestPlatforms 是卡片指向那一版（latestVersion）覆盖的平台。老商城没有这个
	// 字段，解出来是 nil；上游给 `[]` 表示「这一版没有发布资产」，两者不是一回事，
	// 所以不能把 nil 和空切片一起处理（见 latestPlatformValues）。
	LatestPlatforms []upstreamPlatform     `json:"latestPlatforms"`
	Compatibility   *upstreamCompatibility `json:"compatibility"`
}

type upstreamCatalog struct {
	Items         []upstreamSummary      `json:"items"`
	Total         int                    `json:"total"`
	NextCursor    *string                `json:"nextCursor"`
	Compatibility *upstreamCompatibility `json:"compatibility"`
	// Compat 是商城回显的「本次实际生效口径」（compatible / all）。老商城不发送，
	// 留空即不写进插件响应，页面按 compatibility.estimated 推断。
	Compat string `json:"compat"`
}

type upstreamProduct struct {
	upstreamSummary
	Readme   *upstreamReadme   `json:"readme"`
	RepoURL  *string           `json:"repoUrl"`
	Author   *upstreamAuthor   `json:"author"`
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
	// GitHub 账号：字母数字与连字符，1–39 个字符（GitHub 自身的上限）。
	githubLoginPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`)
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

// installedRelation 的取值集合，页面按这四个键出文案与门禁。
const (
	relationNewer   = "newer"
	relationSame    = "same"
	relationOlder   = "older"
	relationUnknown = "unknown"
)

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
// 用来把 iconUrl / socialImageUrl 拼成绝对地址；inventory 是宿主已装清单快照，
// 用来标注 installed 与 updateAvailable。
// 返回 dropped：形状不合法的条目数量，handler 只把它写进日志。
func catalogResponseValues(result catalogResult, baseURL string, inventory installedInventory) (map[string]any, int) {
	items := make([]any, 0, len(result.page.Items))
	dropped := 0
	for _, item := range result.page.Items {
		values, ok := catalogItemValues(item, baseURL, inventory)
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
	// 商城回显的生效口径原样透出；没有回显就不写这个键，页面会按 estimated 推断。
	// 不在这里补默认值：口径规则属于商城，补一个会让页面与真实过滤强度脱节。
	if compat := strings.TrimSpace(result.page.Compat); compat != "" {
		values["compat"] = compat
	}
	return values, dropped
}

// catalogItemValues 只映射 catalog.response 定义过的字段：tags / owner 这类
// 上游字段一律丢弃，页面看到的是稳定形状。
func catalogItemValues(item upstreamSummary, baseURL string, inventory installedInventory) (map[string]any, bool) {
	if !validKind(item.Kind) || strings.TrimSpace(item.Slug) == "" {
		return nil, false
	}
	installed, found := inventory.lookup(item.ExtensionID)
	values := map[string]any{
		"slug":           item.Slug,
		"extensionId":    item.ExtensionID,
		"name":           item.Name,
		"kind":           item.Kind,
		"summary":        item.Summary,
		"category":       nullableText(item.Category),
		"iconUrl":        absoluteAssetURL(baseURL, item.IconURL),
		"socialImageUrl": absoluteAssetURL(baseURL, item.SocialImageURL),
		"latestVersion":  item.LatestVersion,
		// 清单里的宿主约束，原样透出：目录行展示它，判定仍由 core 在安装时做。
		"sforumVersion": item.SForumVersion,
		"platforms":     platformValues(item.Platforms),
		// 卡片徽标判定的是「最新这一版能不能装」，不是「有没有某一版能装」。
		"latestPlatforms": latestPlatformValues(item),
		"compatibility":   compatibilityValues(item.Compatibility),
		// 已装信息只来自宿主清单：读不到就是 null / false，不推断。
		"installed":       installedValues(installed, found),
		"updateAvailable": updateAvailable(installed.Version, item.LatestVersion),
	}
	if updatedAt := strings.TrimSpace(item.UpdatedAt); updatedAt != "" {
		values["updatedAt"] = updatedAt
	}
	return values, true
}

// absoluteAssetURL 把商城给的相对资产地址拼成绝对地址。图标与分享卡共用这条规则：
// 两者都是内容寻址的公开资源，商城给的都是 /api/assets/<sha> 这样的相对路径。
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
// inventory 提供 installed / updateAvailable，与目录项同源。
func productResponseValues(result productResult, baseURL string, inventory installedInventory) (map[string]any, int, error) {
	if !validKind(result.product.Kind) || strings.TrimSpace(result.product.Slug) == "" {
		return nil, 0, &upstreamError{category: errUpstreamFailure, kind: "invalid_product"}
	}

	// 清单先读：每个版本的 installedRelation 都相对它算，页面只做展示不再做版本比较。
	installed, found := inventory.lookup(result.product.ExtensionID)

	releases := make([]any, 0, len(result.product.Releases))
	dropped := 0
	for _, release := range result.product.Releases {
		values, ok := releaseValues(release, installed.Version, found)
		if !ok {
			dropped++
			continue
		}
		releases = append(releases, values)
	}
	product := map[string]any{
		"slug":            result.product.Slug,
		"extensionId":     result.product.ExtensionID,
		"name":            result.product.Name,
		"kind":            result.product.Kind,
		"summary":         result.product.Summary,
		"readme":          readmeValues(result.product.Readme),
		"category":        nullableText(result.product.Category),
		"iconUrl":         absoluteAssetURL(baseURL, result.product.IconURL),
		"socialImageUrl":  absoluteAssetURL(baseURL, result.product.SocialImageURL),
		"repoUrl":         nullableText(result.product.RepoURL),
		"platforms":       platformValues(result.product.Platforms),
		"latestPlatforms": latestPlatformValues(result.product.upstreamSummary),
		"releases":        releases,
		"installed":       installedValues(installed, found),
		"updateAvailable": updateAvailable(installed.Version, result.product.LatestVersion),
		"author":          authorValues(result.product.Author),
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

// installedValues 把宿主清单里的同 id 条目映射成 installed。未知（清单没读到、
// 或者这台宿主确实没装）给 null：页面据此不显示任何「已安装」结论。
// 返回 any（nil 或对象）：路由正文是 protobuf Struct，指针不是合法 JSON 值。
func installedValues(item installedExtension, known bool) any {
	if !known {
		return nil
	}
	return map[string]any{"version": item.Version, "status": item.Status}
}

// updateAvailable 只在两端都能被 semver 解析时给结论：清单里的版本可能是 dev
// 标签或历史写法，解析失败就保持 false，不猜「大概能升级」。等值也不算可升级。
func updateAvailable(installedVersion, latestVersion string) bool {
	current, err := semver.NewVersion(strings.TrimSpace(installedVersion))
	if err != nil {
		return false
	}
	latest, err := semver.NewVersion(strings.TrimSpace(latestVersion))
	if err != nil {
		return false
	}
	return current.LessThan(latest)
}

// releaseValues 生成一个版本的 DTO。installedVersion / installedKnown 来自宿主清单：
// 只用来算 installedRelation，拿不到清单就不写这个键（页面按未安装处理）。
func releaseValues(release upstreamRelease, installedVersion string, installedKnown bool) (map[string]any, bool) {
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
		"notesHtml":     nullableText(release.NotesHTML),
		"capabilities":  stringValues(release.Capabilities),
		"assets":        assets,
	}
	if digest := strings.TrimSpace(release.Digest); digest != "" {
		values["digest"] = digest
	}
	if relation := installedRelation(installedVersion, installedKnown, release.Version); relation != "" {
		values["installedRelation"] = relation
	}
	return values, true
}

// installedRelation 描述「这个版本」相对「本机已装版本」的位置：
//
//	newer   可升级（选中版本高于已装）
//	same    同版本（重装只会得到同一份候选）
//	older   低于已装（降级，需要先卸载）
//	unknown 有一端不是 semver，页面不做门禁只提示
//
// 空串表示宿主清单不可用，调用方不写这个键。比较用与 updateAvailable 同一个
// Masterminds 实现：页面是零依赖手写 ESM，不能有第二套版本比较。
func installedRelation(installedVersion string, installedKnown bool, releaseVersion string) string {
	if !installedKnown {
		return ""
	}
	current, err := semver.NewVersion(strings.TrimSpace(installedVersion))
	if err != nil {
		return relationUnknown
	}
	candidate, err := semver.NewVersion(strings.TrimSpace(releaseVersion))
	if err != nil {
		return relationUnknown
	}
	switch {
	case candidate.Equal(current):
		return relationSame
	case candidate.GreaterThan(current):
		return relationNewer
	default:
		return relationOlder
	}
}

// authorValues 映射 author。两半都为空时返回 nil（页面不画作者条）；只有一半时只发一半，
// 绝不拿另一半的名字填空。
func authorValues(author *upstreamAuthor) any {
	if author == nil {
		return nil
	}
	username := trimmedText(author.Username)
	displayName := trimmedText(author.DisplayName)
	avatarURL := httpURLText(author.AvatarURL)

	values := map[string]any{
		"username":    nullableString(username),
		"displayName": nullableString(displayName),
		"avatarUrl":   nullableString(avatarURL),
		"profileUrl":  nullableString(httpURLText(author.ProfileURL)),
		"github":      nil,
	}
	if login := githubLogin(author.Github); login != "" {
		values["github"] = map[string]any{
			"login": login,
			"url":   "https://github.com/" + login,
		}
	}
	if values["username"] == nil && values["displayName"] == nil &&
		values["avatarUrl"] == nil && values["profileUrl"] == nil && values["github"] == nil {
		return nil
	}
	return values
}

// githubLogin 只接受 GitHub 允许的账号字符集：它会被拼进 https://github.com/<login>，
// 放行 `/`、`?`、`#` 就等于让上游决定链接指向哪里。
func githubLogin(github *upstreamGithub) string {
	if github == nil {
		return ""
	}
	login := strings.TrimSpace(github.Login)
	if login == "" || !githubLoginPattern.MatchString(login) {
		return ""
	}
	return login
}

// httpURLText 只放行绝对 http(s) 地址：头像交给 <img> 加载，协议路径不能被上游指定。
func httpURLText(value *string) string {
	trimmed := trimmedText(value)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" {
		return ""
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return ""
	}
	return trimmed
}

func trimmedText(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
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

// compatibilityValues 是 §6.2 的落点：上游缺字段、给了未知枚举都统一报 unknown +
// estimated=false，绝不自造兼容结论。宿主版本已经由 setHostVersion 转发给商城，所以
// 这里的 unknown 只表示「商城没给判定」，不再是「插件没报版本」。
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

// latestPlatformValues 输出「卡片指向那一版」的平台。
//
// 上游缺字段（老商城）时回落并集：语义退化成「至少覆盖这些平台」，宁可少拦一次，也
// 不要把一份能装的目录整片标成不支持。上游给了空数组时照实输出空数组 —— 那是「这一
// 版没有资产」，不是「不知道」，页面据此不拦安装。
func latestPlatformValues(summary upstreamSummary) []any {
	if summary.LatestPlatforms == nil {
		return platformValues(summary.Platforms)
	}
	return platformValues(summary.LatestPlatforms)
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
