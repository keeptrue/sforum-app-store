# 目录缓存必须能被显式复核：refresh=1 与 60 秒新鲜窗口

Status: accepted
Date: 2026-10-28

## 背景

管理员在商城发布新扩展后打开「应用商城 → 商城」，列表里没有新条目；勾选或取消
「只看当前版本可安装」之后才出现。现象看着像浏览器缓存，实际是插件后端自己的缓存：

- `upstream.go` 的 `cachedJSON` 按「完整上游 URL」缓存解码后的文档，新鲜窗口 10 分钟，
  **窗口内直接返回内存值，不发任何请求**。
- 页面首屏 `compatMode=auto`，`buildCatalogPath` 因此**省略 `compat`**，落在一个常热的
  缓存键上；勾选开关把 `compat` 换成 `compatible` / `all`，换了键，才被迫去商城取数。
- 刷新按钮复用同一个键，所以按了没有任何变化。
- `stale` 只在「上游失败、用旧值兜底」时为 true；TTL 命中是 `stale=false`，页面不显示
  「数据更新于 X」，旧数据没有任何提示。

商城的 ETag/304 与 `Cache-Control: public, max-age=60, stale-while-revalidate=300` 都是对的，
问题在插件从不复核。

## 决定

1. **路由新增 `refresh` 查询参数**（只接受 `1` 或省略，其余 400 `invalid_request`）。
   它是插件自己的缓存指令：不进 `catalogQuery`、不转发上游、不进缓存键，因此同一个查询
   在「打开页面」与「翻页」之间共用一份缓存，只有新鲜度要求不同。
2. **强制复核只用在需要「现在」的动作上**：首屏、刷新按钮、错误重试/重新检测、打开产品详情
   （含深链）。搜索、频道、分类、兼容开关、加载更多不强制 —— 它们走 60 秒窗口，输入抖动
   不该打商城。
3. **新鲜窗口 10 分钟 → 60 秒**，与商城自己的 `max-age=60` 对齐。窗口比商城大，就必然出现
   「刚发布的扩展要等窗口过去才看得见」。
4. **强制复核仍然走条件请求**：已有缓存时带 `If-None-Match`，304 只刷新 `fetchedAt`；
   上游故障时按原规则回落 stale（24 小时窗口）并标 `stale=true`，页面显示数据时间。
5. **强制复核的上游调用上限 5 秒**（仅「已有缓存」时）：否则商城失联会把每次打开页面都拖成
   客户端的 10 秒超时。冷启动没有兜底，仍用完整预算。
6. **强制复核发 `Cache-Control: no-cache`**：商城的公共读响应带 `max-age=60`，不加这条请求
   指令时 CDN/反代会把「复核」变成它自己的一次本地命中。

## 代价

- 每次打开商城页多一次条件请求（多数是 304，不重传正文）。这是「打开就是现在」的价格。
- 商城持续慢于 5 秒时，强制复核会回落 stale：页面显示旧目录 + 数据时间，而不是空白等待。
- 60 秒窗口内的筛选/翻页仍可能拿到最多 60 秒前的结果集；这是有意的成本控制，不是遗漏。

## 不做

- **不改商城的 `Cache-Control`**：公共目录带 ETag 的 60 秒缓存是合理的；插件用请求指令
  穿透中间层即可。
- **不做后台 SWR + 轮询**：`bridge` 是请求/响应，没有推送通道，轮询的复杂度换不来体验。
- **不改 DTO**：`stale` / `fetchedAt` 已够表达；不为 60 秒窗口再加「数据年龄」提示。

## 验证

- `TestCatalogForcedRefreshSkipsFreshCache`：窗口内普通请求直出；`refresh=1` 触发第 2 次上游
  调用（带 `If-None-Match` 与 `Cache-Control: no-cache`），304 复用正文、`fetchedAt` 前进。
- `TestCatalogForcedRefreshServesStaleWhenUpstreamFails`：强制复核遇 500 时回落 stale，
  `fetchedAt` 保持原始抓取时间。
- `TestCatalogRejectsUnknownRefreshValue` / `TestCatalogDoesNotForwardRefreshUpstream`：
  非法值 400 且不触达上游；`refresh` 不出现在上游查询串里。
- `TestProductForcedRefreshSkipsFreshCache`：详情同一套语义。
- 前端：`buildCatalogPath` / `buildProductPath` 的 `refresh` 用例、首屏与刷新按钮的强制请求、
  筛选不强制。
- 手工：发布新扩展后直接打开商城页应立刻出现；每次打开与点刷新 `fetchedAt` 前进；
  停掉商城后 ≤5 秒出旧列表并显示「数据更新于 X」。
