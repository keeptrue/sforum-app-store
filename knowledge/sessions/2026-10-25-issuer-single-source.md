# 2026-10-25 OAuth2 收敛为单一登录来源 + 接入指引

## 结果

后台「OAuth2 配置」原本允许建任意多个 `active` issuer，但登录侧只有在调用方自带 `?issuer=` 时
才工作，既没有选择页、前台也不渲染 `?error=`——多 issuer 实际是把登录打死。本轮按
`decisions/2026-10-24-app-store-identity-and-distribution.md` 早已写下的口径把「一个部署只有一个
active issuer」变成不变量，并把「在 SForum 里怎么建这个应用」写成可照抄的清单（后台面板 +
`docs/oauth-setup.md`）。

验证：`bun test --parallel=1` → **374 pass / 0 fail / 38 files**（本轮新增 20 例：issuers 16 +
redirect 4）；`bunx tsc --noEmit` 干净；`bun --bun next build` 通过；1633×810 与 390×844 渲染证据见
`tmp/{issuers,issuers-guide,issuer-dialog}-1633.png`、`tmp/{issuers,issuer-dialog,storefront-error}-390.png`。

## 关键实现事实

- **三层不变量**：`oauth_issuers_single_active_idx`（部分唯一索引 `WHERE status='active'`）+
  `lib/admin/issuers.ts#assertNoOtherActiveIssuer`（建 / 重新启用两条路径）+ 后台按钮禁用。
  并发双开由索引兜底，服务层把 `23505` 转成同一个 409 `issuer_active_exists`。
- **drizzle 会包错误**：`db.insert` 的驱动错误是 `DrizzleQueryError`，SQLSTATE 在 `cause` 上。
  `isUniqueViolation` 必须走 cause 链，否则并发冲突会漏成 500（有测试直插第二行 active 验证）。
- **迁移带守卫**：`0007_small_mathemanic.sql` 先数 active，>1 就 `RAISE EXCEPTION` 并给出
  `UPDATE … SET status='retired'` 的处理指令；不静默 retire（那会改写账号归属历史）。
- **`?issuer=` 降级为兼容参数**：0 个 → `no_issuer`；1 个 → 直接用；>1 个（迁移遗留）→
  `multiple_issuers`；参数不匹配 → `unknown_issuer`。`choose_issuer` 分支删除。
- **前台错误面**：`components/storefront/issuer-notice.tsx` 按三个码渲染提示；首页把 `error`
  从分页参数里剔掉，避免错误码被带进目录翻页链接。
- **回调地址单一来源**：`lib/oauth/redirect.ts#sforumCallbackUrl(publicUrl)`，登录路由与后台
  展示共用，防止「复制的那串」和「实际发送的那串」漂移。
- **指引内容取自 provider 源码**，不是推测：字段与提示见
  `sforum-oauth2-provider/plugins/sforum-oauth2-provider/frontend/admin/dist/clients.mjs`；
  1–10 个回调地址、名称 ≤120、`clientType` 见 `backend/clients.go#buildClient`；精确匹配与
  https/回环规则见 `backend/oauth2.go#matchRedirectURI`；六个 scope 见 `backend/constants.go#scopeRegistry`；
  站点默认 `allowed_scopes` 见 `manifest/settings.json`。

## 改动清单

**新增**：`service/src/lib/oauth/redirect.ts`(+test)、`service/src/lib/admin/issuers.test.ts`、
`service/src/components/admin/issuer-guide.tsx`、`service/src/components/storefront/issuer-notice.tsx`、
`service/drizzle/0007_small_mathemanic.sql`、`docs/oauth-setup.md`、本交接。

**修改**：`service/src/lib/admin/issuers.ts`（不变量 + 23505 兜底）、`service/src/db/schema.ts`（索引）、
`service/src/app/api/auth/sforum/start/route.ts`（错误码收敛 + 共用回调地址）、
`service/src/app/(storefront)/page.tsx`（错误面 + 剔除 `error` 参数）、
`settings/issuers/page.tsx`、`issuers-table.tsx`、`issuer-dialog.tsx`、`system-config-panel.tsx`（多 active 告警）、
`docs/README.md`、`docs/deployment.md`、`service/README.md`（删掉已废弃的 `STORE_BOOTSTRAP_*` 行）、
`knowledge/decisions/2026-10-24-app-store-identity-and-distribution.md`（追加「落地」段）。

## 未做 / 未验证

- **不做**多 issuer 选择页 / 联邦登录：决策已否决，重开条件写在决策文件末尾。
- 迁移只在本地库跑过（单 active 行）；**未验证**「库里已有多个 active」时的报错路径——验证方式：
  手工插两行 active 再 `bun run db:migrate`，应看到 `oauth_issuers 有多个 active 行` 并回滚。
- 真实论坛凭据的完整登录仍未验证（本地是 fake provider + 直接种的 issuer 行）。
