# 目录缓存可显式复核：refresh=1 + 60 秒新鲜窗口（插件 0.1.6）

## 现象

商城发布新扩展后打开「应用商城 → 商城」，列表里没有新条目；勾选/取消「只看当前版本
可安装」之后才出现。刷新按钮按了没反应。

## 根因

不是浏览器缓存，是插件后端自己的缓存：

- `upstream.go` 的 `cachedJSON` 按完整上游 URL 缓存，新鲜窗口 **10 分钟**，窗口内直接
  返回内存值、不发请求。
- 首屏 `compatMode=auto` → `buildCatalogPath` 省略 `compat` → 落在常热的缓存键上；
  勾选开关换成 `compat=compatible|all`，换了键才被迫取数。
- 刷新按钮复用同一个键，所以按了没变化。
- `stale` 只在「上游失败兜底」时为 true，TTL 命中不提示数据时间。

## 修法

- 插件路由新增 `refresh` 查询参数（只收 `1`/省略，其余 400）：**不转发上游、不进缓存键**，
  只表示「这次跳过新鲜窗口，向商城条件复核」。
- 首屏、刷新按钮、错误重试、打开详情（含深链）发 `refresh=1`；搜索/频道/分类/兼容开关/
  加载更多不发。
- `cacheFreshTTL` 10 分钟 → 60 秒（与商城 `max-age=60` 对齐）。
- 强制复核仍带 `If-None-Match`；已有缓存时上游调用上限 5 秒，失败按原规则回落 stale
  （24h）并标 `stale=true`；强制复核额外发 `Cache-Control: no-cache` 穿透中间层缓存。
- `openapi/routes.yaml` 补参数说明；决策 `decisions/2026-10-28-catalog-cache-revalidation.md`。

## 证据

- Go：`go vet ./...` + `go test ./...` 通过；新增 `TestCatalogForcedRefreshSkipsFreshCache`、
  `TestCatalogForcedRefreshServesStaleWhenUpstreamFails`、`TestCatalogRejectsUnknownRefreshValue`、
  `TestProductForcedRefreshSkipsFreshCache`；`TestCatalogCacheServesFreshHitAndRevalidatesWithETag`
  按 60 秒窗口重写。
- 前端：`bun test plugin/plugins/sforum.store/frontend/admin/src` → **219 pass / 0 fail**；
  新增「首屏强制复核、筛选不强制」「刷新按钮强制复核」「buildCatalogPath/buildProductPath 的
  refresh」三例，更新 5 处精确路径断言。
- `bash plugin/scripts/build.sh`：`manifest OK: sforum.store 0.1.6 (plugin), 7 routes, 2 admin pages`；
  `backend/plugin`、`catalog.mjs`、`routes.yaml` 摘要与清单逐字节一致。
- 活体（本机 SForum `:3000` / `:8080`，插件已由 dev watcher 重新装配）：
  同一查询连续两次不带 `refresh` → `fetchedAt` 都是 `17:39:43Z`（缓存直出）；
  加 `&refresh=1` → 推进到 `17:40:22Z`；再不带 → 保持新值。
  页面「刷新」按钮实际发出
  `/api/v1/extensions/sforum.store/api/store/catalog?channel=stable&platform=all&refresh=1`，
  列表显示 5 条（修复前截图是 4 条）。

## 版本与后续

- 清单 `0.1.5 → 0.1.6`（v0.1.5 已发版，tag 与清单版本强校验，见 `release.yml`）。未打 tag、未发布。
- 存量站点需重新安装 0.1.6 才会生效；页面与后端可独立升级（旧后端忽略 `refresh`，行为不变）。
- 未做：商城 `Cache-Control` 调整、后台 SWR 轮询、DTO 增加「数据年龄」字段。
