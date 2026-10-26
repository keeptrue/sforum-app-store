# 2026-10-26 管理页三项：更新说明渲染 / 安装门禁 / 作者信息

## Changed

- **更新说明改服务端渲染。** `ReleaseVersion` 新增 `notesHtml`（`notes` 仍是 GitHub 原文）。
  `service/src/lib/readme/render.ts` 抽出 `installRules()`，README 与 notes 各建一个 markdown-it
  实例、共用同一份 sanitize 白名单；notes 不挂 `markdown-it-anchor`（跨版本会撞 id），标题映射到
  `h4` 起（弹窗 `h2` → 版本头 `h3` → 正文 `h4+`）。新增 `service/src/lib/readme/notes.ts`：
  内容寻址 memo（`(source, repoFullName)` 的 sha256，上限 200 条 LRU，逐出只影响 CPU）。
  插件 `notesBlock` 优先 `innerHTML` 注入（容器复用 `.sforum-store-readme`），缺 `notesHtml` 时
  退回原来的 `pre-wrap` 纯文本。
- **`ProductSummary.owner` → 结构化 `author`。** `Author { username, displayName, avatarUrl,
  profileUrl, github { login, url } } | null`；查询侧多 join `github_installations`
  （按 `github_repos.installation_id`）与 `oauth_issuers`（按 `accounts.issuer_key`，只为拼
  论坛主页）。昵称后的 `@用户名` 是链接（`<issuer>/u/<username>`），点击在新标签打开论坛个人
  主页；地址缺失时退纯文本。插件后端把 `login` 过
  `^[A-Za-z0-9][A-Za-z0-9-]{0,38}$` 后**自己拼** `https://github.com/<login>`，头像只放行绝对
  `http(s)`。管理页在 README 分区顶部渲染作者条；商城公开产品页同步改用 `author`。
- **安装门禁。** 插件后端对每个 release 产出 `installedRelation`
  （`newer|same|older|unknown`，与 `updateAvailable` 同一 Masterminds 实现）；页面
  `installGate()` 决定安装条：可装 → 「安装到论坛」/「更新到 vX」；同版本 / 降级 / 不可解析 →
  中性化禁用主按钮「已安装 vX」+ 状态位说明。版本下拉带关系后缀。
  **「去 core 卸载」按钮在当日第二轮按操作者要求移除**：卸载是破坏性动作，不放目录手势路径
  （`decisions/2026-10-26-install-gate.md` 的「修订」段）。
- **清单项目符号。** 宿主 Tailwind preflight 把 `ol/ul` 的 `list-style` 清成 none，插件 CSS 补回
  `disc/decimal`（与商城前台 `globals.css` 的做法一致）。
- **`dist/*.css` 进构建产物。** `build.sh` 改成 `bun build --minify`，与 `.mjs` 同口径；源码
  CSS 保持可读（23,277 B），产物 17,988 B（预算 20,480）。

## Evidence

- 商城：`bun test` **784 pass / 0 fail / 2659 expect / 66 files**，`bun run typecheck` exit 0，
  `contract:generate` 后 `api-types.ts` 已更新。
- 插件：前端 **125 pass / 793 expect / 2 files**（新增 `install-gate.test.ts` 23 条 + `catalog.test.ts`
  的 gate/author/notes 三组），后端 `go vet` + `go test` 绿（新增 `installedRelation` 9 例、
  `authorValues` 5 例、product 路由的 author/notesHtml/relation 断言）。
- 宿主四闸：`extension validate` / `extension test`（6/6 checks, 0 warnings）/ `brand check` /
  `extension package`（`bceb89d1…`）全绿；dev watcher 已把新制品提升为 enabled（digest 随每轮
  `build.sh` 变化，最后一条为 `943ec93f3c63` 之后的构建）。
- 真机（用户浏览器，已登录超管）：OAuth2 Provider 详情 `已安装 v1.6.0` → 更新说明出现真标题
  / 有序清单 / 代码块（截图），安装条 = 唯一一枚禁用「已安装 v1.6.0」，状态位
  「已安装 v1.6.0，同版本无需再装」；点 `@zhuchunshu` 在新标签打开
  `http://127.0.0.1:3000/u/zhuchunshu`（标题「大佬 | SForum」）；站内搜索 `已安装 v1.0.7` + latest `v3.1.0` → 按钮
  「更新到 v3.1.0」、下拉「3.1.0 · 稳定版 · 可升级」；Markdown Plus 未安装 → 「安装到论坛」、
  下拉无关系后缀。390×844（devtools 设备模拟 1170×2532@3）与 1601×625 各一组截图。
- 商城 API 直查：`/api/v1/products/oauth2-provider` 返回 `author`（含 `avatarUrl` 指向论坛
  `/media/avatars/...` 与 `github.url`）与 `notesHtml`（2 个 `h4`、0 个 `h2/h3`、0 个 `id=`）。

## Decisions

- `decisions/2026-10-26-release-notes-markdown.md`
- `decisions/2026-10-26-install-gate.md`
- `decisions/2026-10-26-product-author-surface.md`
- `decisions/2026-10-26-catalog-card-dialog.md` 第 5 条已标注「被取代」。

## Next

- **降级路径只有单测覆盖**：本机没有「已装版本高于商城任一版本」的产品，真机只验了
  same / newer / 未安装三态。
- **staged 候选对清单不可见**（`extensions.active_version_id`）：把新版本暂存但未启用时，
  安装条仍显示「更新到 vX」。要修需宿主清单加 staged 字段（跨仓）。
- 表格滚动容器的 `aria-label` 仍是中文硬编码（`render.ts` 的 `TABLE_OPEN`），en-US 页面会漏出
  中文；要修得给 `renderReadme` 加语言参数。
- 内置浏览器（`dsh`/ego）视口固定在 1601×625 附近；390×844 靠 devtools 设备模拟取得，
  bsk 窗口本身最小 500px。

## Open Questions

- 作者条要不要显示「已发布 N 个产品」之类的副信息？目前只有两半身份。
- 商城公开产品页的「清单作者」与「维护者」并列，是否也要在管理页同屏给出（本轮刻意只给
  维护者，避免两个「作者」）。
