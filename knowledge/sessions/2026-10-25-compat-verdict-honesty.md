# 目录里的「未校验」不再逐条盖戳

日期：2026-10-25
决策：`decisions/2026-10-25-compat-verdict-honesty.md`

## 起因

目录卡右下角恒挂「未校验」，8 张卡一样。查下来它不是产品结论，而是「这次渲染没拿到宿主版本」
的回声，而且**必然**是回声：插件后端显式丢弃 `sforum` / `sforumBuild`（`backend/upstream.go`、
`handlers.go` 的 `catalogQueryFromRequest`，SForum D9 不暴露 `coreVersion`），前台访客的 URL 里
也没有这两个参数。于是每张卡都挂着同一个灰点，占的却是产品名与平台之间的判决位——读起来像
「这个插件没过审」，和真正的生命周期词撞语义。

## 改了什么

- **判词只在有判决时出现。** `badgeForCompatibility` 对 `unknown` 返回 `null`；`catalog.tsx`
  的卡片与插件 `catalogRowView` 都只在有 `兼容 / 不兼容 / 按开发版估算` 时渲染徽标。
- **页级说一次。** `describeCompatibility`（前台）与新增的 `compatibilityNote` + `data-role="compat-note"`
  （插件）各一句：没有宿主版本，只展示约束，判定留给 core。顺手删掉不可达的 `incompatible` 分支
  （`pageCompatibility` 只会返回 `unknown` / `compatible`）。
- **那个位置换成产品事实：清单里的 `sforumVersion` 约束。** 契约 `ProductSummary` 新增必填
  `sforumVersion`（不可解析为空串），插件 `schemas/catalog.response.json` 同步并原样透出；卡片与
  插件行显示 `sforum >=1.4.0 <2.0.0`，超 18 字符截断、`title` 放全量，运算符不改写。
- **商品页版本行**的硬编码「未校验」改用共享常量 `UNJUDGED_LABEL`（「未判定」）。

## 证据

- 服务端：`bun run test` **708 pass / 0 fail**；新文件 `components/storefront/catalog-format.test.ts`
  覆盖「unknown 不出徽标 / 开发版不算判词 / 约束 chip 截断 / 页级措辞」。
- 插件：`bun test plugin/plugins/sforum.store/frontend/admin/src` **46 pass / 0 fail**，三处原本断言
  「出现未校验」的地方改为断言不出现 + 出现说明行；Go `go vet` + `go test ./...` 绿；
  `bash plugin/scripts/build.sh` 重建 dist 与摘要、清单校验 OK。
- 闸门：`typecheck` 干净，`contract:generate` 后无漂移，`manifest:check` / `capabilities:check` 均绿。
- 运行时（dev，127.0.0.1:4000）：
  - `curl /` → 0 处「未校验」，1 句「未提供论坛版本 · 本页只展示各版本的 sforumVersion 约束…」，
    8 张卡各带 `sforum >=…` chip。
  - `?sforum=3.0.20` → 4 张「兼容」且默认过滤掉其余；`?sforum=9.9.9&compat=all` → 4 兼容 + 4 不兼容；
    `?sforumBuild=dev-abc` → 5 张「按开发版估算」。
  - `/p/<slug>` → 0 处「未校验」，版本表显示「未判定」。
  - 1633 逻辑视口实测：卡片 623px、四个 chip 单行（`chipRows: 1`）、无横向溢出
    （`docScrollW == docClientW == 1618`）。

## 未验证（照实写）

- **390×844 移动端实测未取到**：本机 ego 运行时接受 `Emulation.setDeviceMetricsOverride`
  （JS 侧 `innerWidth` 会变），但镜像窗口/截图面仍是 500×864，移动端覆盖不生效。窄窗（500px）
  实拍显示 chip 换行到独立一行、无溢出；390 仍未验证。
- **插件管理页没有真机渲染**：需要带管理员会话的 SForum 宿主，本次只有单测与打包校验。
- 1633 桌面截图也取不到（同一镜像 500px 限制），桌面证据是逻辑视口测量 + SSR HTML，不是像素。

## 下一步

- 有管理员会话时补插件目录页截图（`data-role="compat-note"` 与行内 chip）。
- SForum 放开 D9 后，插件后端转发 `sforum` / `sforumBuild`，判词自动恢复成真判决；届时页级文案
  走 `compatFilteredNote`，卡片分支已保留。
