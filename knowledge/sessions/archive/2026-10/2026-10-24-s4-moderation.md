# 2026-10-24 Session Handoff — S4 审核流与开发者门户

## Changed

### 契约 / 决策

- 审核规则落成决策记录 `knowledge/decisions/2026-10-24-s4-review-flow.md`：双轴状态（产品轴 /
  版本轴）、自动发布的不变量、**重新进审拦在发布边界而不下架已上线产品**、v1 能力不分风险
  等级、单审员、证据与状态同事务、yank/delist 语义。
- `contracts/store-api.yaml` 本轮未改（审核与门户是会话态内部 API，不进跨产物契约）。

### Schema（迁移 `0004`，dev + test 库已应用）

- `moderation_events`：subject 二选一（product / release_version）、`action`、`from_state`、
  `to_state`、`actor_account_id`（null = 系统）、`reason`、`created_at`。
- `audit_log`：actor、action、`target_type/target_id`、`details` JSON、ip、created_at。
- `products` + `name_at_review`、`repo_id_reviewed`、`capabilities_reviewed[]`、`published_at`。

### 服务端

- **策略**：`src/lib/moderation/policy.ts`（Lead）—— `decideReleaseState` 纯函数：产品未发布 →
  待审；快照缺失 / 改名 / 换仓 / 出现未审过的能力 → 待审；否则自动发布。已接入
  `syncRelease`，复审时写 `moderation_events(re_review_required)`（actor 为 null）。
- **证据写入**：`src/lib/moderation/events.ts`（Lead）—— `recordModerationEvent` 强制 subject
  二选一；`recordAudit` 记 actor/action/target/details/ip。
- **审核域**：`src/lib/moderation/{store,queue,service}.ts` —— 条件更新（`WHERE state=…`
  自带状态机）、`approveProduct`（发布产品与其待审版本、写快照、`published_at` 首次写入、
  重算 latest）、`rejectProduct`、`delistProductAsModerator`、`approveVersion`、
  `rejectVersion`、`authorizeModerationRequest`（401/403/同源）。
- **审核路由**：`/api/moderation/queue`、`/products/{id}`（详情）、`/products/{id}/{approve,
  reject,delist}`、`/versions/{id}/{approve,reject}` —— 7 条，全部 transport only。
- **开发者生命周期**：`submitProductForReview`（draft|rejected|pending_review|delisted →
  pending_review；要求可审版本 + 默认语言文案；已在待审时幂等）、`yankReleaseVersion`
  （published → yanked + reason，重算 latest），路由
  `/api/dashboard/products/{id}/submit`、`/api/dashboard/versions/{id}/yank`。
- **DTO**：`DashboardProduct` + `reviewReason`（最近一次拒绝理由）；`DashboardProductDetail` +
  `versions` / `publishedAt` / `nameAtReview` / `repoIdReviewed` / `capabilitiesReviewed`；
  新增 `src/lib/moderation/types.ts`（队列/详情/事件）。
- **仪表盘列表**：显示名取默认语言翻译（与详情一致）、附拒绝原因；读取 `versions` 走一次批量
  helper（`listVersionRowsForProduct` / `listLatestRejectionReasons`）。
- **命名修正**：`productRenamed` 只在存在快照时为真——没有快照的产品属于
  `snapshot_missing`，不能被标成「改名」。

### 前端

- `/dashboard`（我的产品）与 `/dashboard/products/[id]`（编辑器）：文案/分类/标签、图标与截图
  上传（dnd-kit 键盘排序）、提交审核、撤回版本；成功给 Toast，阻塞错误留在表单旁
  （`components/dashboard/**`，19 个文件，含 `components/ui/select.tsx` 原生 select）。
- `/moderation`：`react-resizable-panels` 左右分栏（<md 单列）、待审产品 / 等审版本两组队列、
  详情含能力差异、版本表、事件时间线；拒绝/下架强制 1..500 字理由，批准为确认框
  （`components/moderation/**`，14 个文件）。
- 两页均 `force-dynamic` + `nodejs`；未登录 `redirect()` 到
  `/api/auth/sforum/start?redirect=…`；`/moderation` 无审核角色 `notFound()`。

## Verified

- `bun test` → **271 pass / 0 fail / 1097 expect() / 28 files**（审核域 46、策略 8、
  产品生命周期 8、同步策略 3、其余沿用 S3）。
- `bun --bun next build` → 通过；`/dashboard`、`/dashboard/products/[id]`、`/moderation` 与
  7 条审核 API 全部 `ƒ` 动态。
- `bun install --frozen-lockfile` → `no changes`；`bunx tsc --noEmit` → 干净。
- **curl 全流程（生产构建 + dev 库，`STORE_PUBLIC_URL=http://localhost:3015`）**：
  - 建产品 → 无版本提交 → 409 `no_reviewable_version`；插入 candidate 版本后提交 → 200，
    状态 `pending_review`，队列出现该产品（提交人、1 个版本、1 项能力）。
  - 匿名 → queue 401、页面 307 到登录；无角色账号 → queue 403 `forbidden`、页面 404。
  - 跨源 approve → 403 `cross_origin`。
  - approve → 产品 published、版本 published 且写 `published_at`、快照（名称/仓库/能力并集）与
    首次发布时间落库；目录 total 4 且出现该产品；`/p/s4` 200；
    `moderation_events` = submitted + approved，`audit_log` = product.submitted + product.approved。
  - 第二个产品 reject（理由 1..500）→ `rejected`；空理由 → 400 `invalid_reason`；
    门户列表出现「拒绝原因：…」，详情页同样回显；被拒后可再次提交（200）。
  - API yank `markdown-plus 1.4.2`（理由）→ 已签发 token 从 503（复核通过、上游 fake）变为
    **410 `release_unpublished`**；`latest_stable_version_id` 从 1.4.2 重算为 1.4.0；
    `moderation_events(yanked)` + `audit_log(release_version.yanked)`。
- **浏览器证据（1633×810 / 390×844，`document.scrollWidth == innerWidth` 均成立）**：
  `/tmp/s4-dashboard-1633.png`、`/tmp/s4-dashboard-390.png`、
  `/tmp/s4-moderation-1633.png`、`/tmp/s4-moderation-1633-queue.png`、
  `/tmp/s4-moderation-390.png`、`/tmp/s4-moderation-390-queue.png`。队列在桌面为双栏、390 下
  单列堆叠；截图里「DeepSeek · …」浮标是 agent 叠加层，不是页面元素。

## Next

1. **S5 插件**：`sforum.store` Go 后端 + 预构建 Vue 管理页；目录/详情/安装/更新 + ETag 缓存；
   安装交接只到 `staged`；浏览器 1633×810 + 390×844 端到端。
2. S5 前补一次**真实 SForum provider 登录**与**真实 GitHub App** 冒烟（S1/S2 遗留）。
3. S6：限流（登录/提交/下载/恢复仓库）、yank 之后的管理面、能力目录与风险分级
   （届时放宽「任何新能力都复审」）、备份与自部署矩阵。

## Open

- **GitHub Actions 提示（§7.4 第 25 条，可选）未实现**：审核页没有 workflow run 区块，
  因此也不存在任何「已验证构建」措辞。留到 S5/S6。
- **改名后的展示名在批准前就已对外可见**（决策记录第 3 条）：重审只拦新版本。若产品长期
  不发新版，审核详情会一直挂着「改名」提示。
- **`ModerationQueueProduct` 不含 `capabilitiesNew` / 详情不含 `repoIdReviewed`**：待审产品通常
  没有快照（首审），差异显示在版本级与详情的能力对照里；仓库绑定变更目前只能从事件
  `re_review_required` 的 reason 看出。
- **`/moderation` 无审核员时返回 404**，因此 SForum 超管也需要 `store_roles` 行才看得到入口
  （`STORE_BOOTSTRAP_ADMINS` 播种）。
- **仪表盘列表的「最新版本」是每产品一次详情读**（N+1，C 的注释已注明）；产品数量级上来后
  应把 `latestVersion` 下推到列表 DTO。
- 视觉证据由本机浏览器在 390 与 1633 两档截取；`STORE_PUBLIC_URL` 必须与浏览器 origin 一致，
  否则所有 mutation 403 `cross_origin`（本地起服务时注意）。
- dev 库里留了两个演示产品（`s4` 已发布、`s4-2` 待审），由真实 API 流程创建；`bun run seed:dev`
  是幂等补数据，不会删除它们。
