# 2026-10-25 管理员后台（本地身份 + OAuth2 配置面）

## 结果

管理员后台按 `plans/2026-10-25-admin-console.md` 一次交付完整 v1：商城本地管理员身份
（`admin_accounts` + `admin_sessions`，scrypt）、可配置后台路径（`STORE_ADMIN_PATH`，默认
`/admin`）、一次性 setup token 注册首个管理员、OAuth2 issuer 全部后台可配
（`STORE_BOOTSTRAP_ISSUER` / `STORE_BOOTSTRAP_ADMINS` 删除）、六个模块全部可用。

`bun test --parallel=1` → **350 pass / 0 fail / 35 files**（基线 312，本轮 +38）；
`bunx tsc --noEmit` 干净；`bun --bun next build` 通过，`bun --bun next start` 下 7 个页面全 200。

## 关键实现事实

- **路径**：顶层动态段 `app/[adminPath]/`，`layout.tsx` 比对 `config.adminPath`，不符
  `notFound()`。没用 `proxy` 重写（Next 16 把 middleware 改名 proxy 且固定 Node 运行时，
  能满足读 env，但要多一条「内部路径必须封死」的规则）。改 env 重启即生效，不重建镜像。
- **路由组**：`(auth)` 放 login/setup/password（不受会话闸门约束），`(console)` 放七个页面
  （会话闸门 + `must_change_password` 重定向）。
- **密码**：`node:crypto` scrypt `N=32768,r=8,p=1,keylen=64`，格式 `scrypt$N$r$p$salt$hash`
  自描述；实测 ~92 ms。不用 `Bun.password`（`next start` 回退 Node 时不存在）。
- **会话**：`__Host-store_admin_session`，绝对 8 小时，与论坛会话完全隔离；改密与重置会清掉
  该账号全部会话。
- **认领**：`registerFirstAdmin` 在事务里先 `pg_advisory_xact_lock` 再数一次，并发双注册只有
  一个成功（有测试覆盖）。成功后判据是「存在 admin 行」，`/setup` 永久 404。
- **授权**：页面 `getAdminSession`；API `authorizeAdminRequest`（写操作先同源）。
- **写操作**：全部 `recordAudit(..., { actorAdminId })`，`audit_log.actor_admin_id` 为管理员专用列。

## 改动清单

**新增（Lead）**：`src/app/[adminPath]/**`（layout + 3 个 auth 页 + 7 个 console 页）、
`src/lib/admin/{password,session,cookies,guard,errors,http,setup,auth,accounts,overview,products,issuers}.ts`、
`src/app/api/admin/**`（session/setup/password/accounts×3/forum-accounts×2/audit/products×3/issuers×2/system）、
`src/components/admin/**`（shell/nav/sign-out/login/setup/password 表单、accounts/products/issuers 三张表、
create-admin 与 issuer 两个对话框）、`scripts/admin-password.ts`、`drizzle/0006_wooden_cable.sql`、
`test/issuer-fixture.ts`、`src/lib/admin/admin.test.ts`。

**队友交付**：`audit-console`（`lib/admin/audit.ts`、`lib/admin/policy.ts`、审计页、发布策略页、
6 个组件、`audit.test.ts` 8 例）；`system-console`（`lib/admin/system.ts`、系统健康页、7 个组件、
`system.test.ts` 12 例）。

**修改**：`src/db/schema.ts`（admin 两张表 + `audit_log.actor_admin_id`）、`src/lib/config.ts`
（`adminPath`/`adminSetupToken`/`adminSessionTtlSeconds`/`adminUrl`，删 `bootstrapIssuer`）、
`src/lib/auth/service.ts`（删 `ensureBootstrapIssuer`/`grantBootstrapRole`，`completeLogin` 收
`issuerKey`，新增 `listActiveIssuers`）、`app/api/auth/sforum/{start,callback}`（issuer 读 DB、
`?issuer=`、无 issuer 时 303 到 `/?error=no_issuer`）、`lib/moderation/events.ts`（`actorAdminId`
+ 三个新 targetType）、`lib/moderation/service.ts` 与 `lib/products/service.ts`（delist/yank 接受
管理员 actor，跳过 owner 检查）、`lib/github/sync.ts`（自动发布写 `auto_published` 事件）、
`lib/ratelimit/rules.ts`（`admin-login` 通道）、`lib/http-client.ts`（从 dashboard/api 抽出的共享
客户端）、`scripts/seed-dev.ts`（写 issuer 行）、`package.json`（`admin:password`）。

**文档**：`AGENTS.md`（边界 1/7 改写 + 新增「管理员后台」一节）、`docs/deployment.md`（初始化五步、
`STORE_ADMIN_PATH`、`STORE_ADMIN_SETUP_TOKEN`、CLI 重置）、`.env.example`、
`knowledge/decisions/2026-10-25-admin-local-identity.md`、`knowledge/plans/2026-10-25-admin-console.md`。

## 验证证据

- **测试**：全量 350/0；新增 `admin.test.ts` 18 例（哈希往返/同密码不同盐/坏哈希不抛、密码策略、
  首次注册成功/错 token/未配置 token/二次注册/并发只成功一个、登录成功/大小写/失败计数/5 次锁定/
  禁用账号、新建管理员强制改密、最后一个 admin 不可禁用、moderator 授予撤销）；`audit.test.ts` 8 例；
  `system.test.ts` 12 例。`sync.test.ts` 增加断言：自动发布写 `auto_published` + reason `approved`。
- **构建**：`bun --bun next build` 通过；`next start` 下 `/admin`、`/admin/accounts`、`/admin/audit`、
  `/admin/products`、`/admin/system`、`/admin/settings/issuers`、`/admin/settings/policy` 全 200；
  无 cookie 307 → `/admin/login`；`/`、`/p/search-site` 200，`/dashboard`、`/moderation` 仍 307 到 OAuth。
- **端到端**：空库 → `POST /api/admin/setup`（带 `.env.local` 的 setup token）创建 `root` → 浏览器
  登录表单登录成功 → `/admin` 概览渲染（待审产品 1 / 待审版本 1 / 已发布 4 / 活跃 issuer 1）→
  `/admin/setup` 变 404。issuer 探针在 fake provider 未启动时如实返回
  `{"ok":false,"message":"连接失败：Unable to connect..."}`。
- **限流与锁定**：验证期间 `admin-login` 桶累计 24 次后被 429（限流生效）；账号锁定 5 次 / 15 分钟
  由测试覆盖。
- **视觉**：`tmp/admin-01-overview-1633.png`、`-02-accounts-1633`、`-03-audit-1633`、`-04-products-1633`、
  `-05-issuers-1633`、`-07-policy-1633`（均 1633×810）；系统健康页见队友的 `tmp/system-1633.png`。
  390 窄屏：`tmp/admin-06-accounts-390.png`（390 视口下 `scrollWidth=375`，无横向溢出）。

## 本轮修掉的一个真实缺陷

首版窄屏下三张表横向溢出，操作按钮被挤出屏幕。已按断点收列（`hidden md:table-cell` /
`lg:table-cell`）并把操作区改为 `flex-wrap`；390 视口复测无横向滚动。

## 已知偏差 / 待办

1. **`moderation_events` 的自动发布原先没有痕**：`sync.ts` 只在退回人工时写事件，导致后台「最近
   判定」看起来全是人工通过。已补 `auto_published`（reason 沿用 `decideReleaseState` 的取值）。
2. **失败登录的审计 actor 显示「系统」**：`admin.login.failed` 没有已认证 actor，`actor_admin_id`
   为空，审计页按「系统」渲染。语义可接受但读起来像系统自己登录失败；若要在意，需在 `details`
   里带上尝试的用户名并在列表里优先展示。
3. **两个 admin 并存时的取舍**：管理员与论坛账号是两行账号（见决策记录），后台分两块展示，
   论坛账号上的旧 `store_roles.role='admin'` 标「旧 admin（不生效）」。
4. **本地 dev 库**：`root` 是验证期间注册的真实管理员（密码 `initial-password-123`，仅本地）。
   验证期由队友临时建的 `admin` 账号与其会话已删除。
5. **未做**：TOTP/WebAuthn；管理员操作的通知；审计保留期清理（计划里仍是开放项）。

## 未验证

- **多 issuer 的真实登录**：`?issuer=` 与选择页逻辑只在单 issuer 下走过；真实论坛凭据仍缺。
- **setup token 轮换后的行为**：token 只在注册时用一次，之后无代码路径再读；未做「换 token 后
  旧入口是否 404」的实测（逻辑上由「存在 admin」判定，与 token 无关）。
- ~~`next start` 下的 scrypt 性能~~——**已补验**：本机 4000 上跑的是 Node 运行时的
  `next start`（非 `bun --bun`），`POST /api/admin/session` 带正确密码返回 200，整条请求
  （含一次 scrypt）182 ms。这同时证明密码校验确实不依赖 Bun 全局。
