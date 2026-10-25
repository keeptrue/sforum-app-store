# 管理员后台（本地身份 + OAuth2 配置面）

Status: **active（2026-10-25 人工批准）**
Started: 2026-10-25

- **权威副本**：本文件。
- **前置**：`plans/2026-10-24-app-store-service.md`（S0–S6 已交付，active 待确认）。
- **本轮性质**：**架构变更**，不是增量页面。商城从「单一论坛身份」变成「两条独立身份线」，
  `AGENTS.md` 边界 1（无注册无密码）与边界 7（角色不来自论坛用户组）需要同步改写。
- **决策记录**：落地后写 `decisions/2026-10-25-admin-local-identity.md`。

## 1. 目标与非目标

**目标**

1. 商城拥有自己的管理员身份：本地账号 + 密码，不依赖 SForum。
2. 后台路径可由 `STORE_ADMIN_PATH` 配置（默认 `/admin`），改 env 重启即生效，不重建镜像。
3. 库里没有任何管理员时，首次访问进入「注册首个管理员」模式，凭一次性 setup token 完成。
4. OAuth2 登录方式（issuer）全部在后台配置，`STORE_BOOTSTRAP_ISSUER` 废弃。
5. 六个管理模块：账号与角色、审计日志、全局产品、issuer 与 GitHub 状态、系统健康、发布策略（只读）。

**非目标（v1 明确不做）**

- 邮箱验证、找回密码、邀请邮件（商城无邮件设施；重置走 CLI）。
- TOTP / WebAuthn 二次验证（留待后续；v1 靠限流 + 锁定 + 审计）。
- 管理员注册开放给任意人（setup 成功后入口永久关闭）。
- 下载失败率统计（现无记录点，加表等于往下载热路径塞写；健康页只做已有数据）。
- 发布策略可写（策略仍在 `lib/moderation/policy.ts`，后台只读展示 + 最近判定）。

## 2. 身份模型（本轮最大变更）

| 主体 | 身份来源 | 会话 | 角色 |
| --- | --- | --- | --- |
| 开发者 / 论坛用户 | SForum OAuth2（issuer 由后台配置） | `__Host-store_session` | `moderator`（由管理员授予） |
| 管理员 | 本地账号 + 密码 | `__Host-store_admin_session` | 无角色表，存在即 admin |

- 两条线**互不授予**：OAuth 账号永远不是 admin；本地管理员也不进开发者门户。
- `store_roles.role='admin'` **废弃**：旧行保留、不参与任何鉴权，文档写明。
- `STORE_BOOTSTRAP_ADMINS` 删除；`grantBootstrapRole` 一并移除。
- 同一自然人既是管理员又要发布扩展时，会有两个账号行。这是刻意取舍，写进文档。

## 3. 数据模型

新增枚举 `admin_status = ('active','disabled')`。

```
admin_accounts
  id uuid pk default gen_random_uuid()
  username text not null
  password_hash text not null          -- scrypt$N$r$p$salt_b64$hash_b64（自描述，便于日后提参数）
  display_name text
  status admin_status not null default 'active'
  must_change_password boolean not null default false
  failed_attempts int not null default 0
  locked_until timestamptz
  last_login_at timestamptz
  created_at / updated_at timestamptz not null default now()
  unique index admin_accounts_username_idx on lower(username)

admin_sessions
  id uuid pk
  admin_id uuid not null references admin_accounts(id) on delete cascade
  token_hash text not null unique      -- sha256，明文不落库（与现有 sessions 同法）
  expires_at timestamptz not null
  user_agent text / ip text
  created_at timestamptz not null default now()
  index on admin_id, expires_at

audit_log
  + actor_admin_id uuid null references admin_accounts(id) on delete set null
  + index audit_log_actor_admin_idx
```

**不加**：不给 `accounts` 加 `password_hash`（隔离是本次决策的核心）；不新建 settings 表
（发布策略只读）。

## 4. 路由与路径配置

**`STORE_ADMIN_PATH`**，默认 `/admin`。启动校验（`ConfigError`，与现有风格一致）：

- `^\/[a-z0-9][a-z0-9-]{0,31}$` —— 单段，只吃一段路径。
- 与保留前缀冲突即失败：`/api`、`/dashboard`、`/moderation`、`/p`、`/_next`、`/favicon.ico`。
- 不支持多段（`/ops/admin`）：动态段吃不下，文档写明。

**实现：顶层动态段 `app/[adminPath]/`**，不用 `proxy` 重写。

- 依据（Next 16.4.3 源码）：`middleware` 已改名 `proxy`，且 `proxy` 固定 Node 运行时
  （`build/analysis/get-page-static-info.js` 对 proxy 文件直接拒绝自定义 runtime）。它能读
  请求时 env，但需要额外封死「内部真实路径」，多一层易错规则；动态段没有这个问题。
- 静态路由（`/dashboard`、`/moderation`、`/p/*`、`/api/*`）优先级高于动态段，互不影响。
- `app/[adminPath]/layout.tsx` 首件事：`params.adminPath !== config.adminPath` → `notFound()`。
- 路由组拆分，让登录/注册页不受会话闸门约束：

```
app/[adminPath]/
  layout.tsx                     路径闸门
  (auth)/login/page.tsx          密码登录
  (auth)/setup/page.tsx          首个管理员注册
  (console)/layout.tsx           会话闸门 + 后台外壳（侧栏/顶栏）
  (console)/page.tsx             概览
  (console)/accounts/page.tsx    账号与角色
  (console)/audit/page.tsx       审计日志
  (console)/products/page.tsx    全局产品
  (console)/system/page.tsx      系统健康
  (console)/settings/issuers/…   OAuth2 配置
  (console)/settings/policy/…    发布策略（只读）
```

**语义**：路径不匹配 → 404；未登录 → 跳 `<adminPath>/login`；已登录非管理员不存在这个概念
（没有账号就是没有账号）。全部 `robots: noindex, nofollow`。

**可配置路径是混淆不是防护**：真正的边界是会话 + 账号存在性检查，这条写进 `AGENTS.md`。

## 5. 首个管理员注册（setup）

- 判定「无管理员」：`select count(*) from admin_accounts` = 0。
- `STORE_ADMIN_SETUP_TOKEN`：**必填才有注册能力**。未配置时 `/setup` 不报错，显示「未配置
  setup token」+ 生成命令（`openssl rand -base64 32`），避免「忘配 = 谁都能注册」。
- 表单：token、username、password、确认密码。token 用常量时间比较。
- 成功后：写 `admin_accounts`（`must_change_password=false`）→ 写审计
  `admin.bootstrap.registered` → 建会话 → 跳后台概览。
- 之后 `/setup` 一律 404（判据仍是「存在 admin 行」，不需要额外状态位）。
- 并发：`pg_advisory_xact_lock` + 事务内二次检查计数，第二个请求回 `already_initialized`。
- 审计记录 IP 与 UA；token 明文不进日志。

## 6. 密码与会话

- 哈希：`node:crypto` scrypt，`N=32768, r=8, p=1, keylen=64`，16 字节随机盐，实测约 92 ms。
  **不用** `Bun.password`：`next start` 回退 Node 时 Bun 全局不存在。
  存储格式 `scrypt$32768$8$1$<salt_b64>$<hash_b64>`，校验时按串内参数重算，便于日后提强度。
- 策略：12–200 字符；不得与用户名相同；不做符号/大小写硬规则（长度优先）。
- 登录：失败 5 次锁 15 分钟（`failed_attempts` + `locked_until`），每次失败写审计；成功清零。
  新增限流通道 `admin_login`（复用 `rate_limits`）。
- 会话：绝对 TTL 8 小时，不滑动；登录即新建（支持多设备），可查看会话数与强制下线。
- 重置：CLI `bun run admin:password -- <username>`（隐藏输入），写审计 `admin.password.reset`。
- 后台新建管理员：设初始密码 + `must_change_password=true`，登录后强制改密才能进其它页。

## 7. 六个模块

| 模块 | 数据源 | 写操作 |
| --- | --- | --- |
| 账号与角色 | `admin_accounts` / `accounts` / `store_roles` / `sessions` | 建/禁用管理员、重置密码、踢管理员会话；给论坛账号授予/撤销 `moderator`、踢论坛会话 |
| 审计日志 | `audit_log`（+ 新 `actor_admin_id`） | 无（按 actor/action/target/时间筛选，游标分页） |
| 全局产品 | `products` / `release_versions` / `release_assets` | 强制下架、yank 版本（复用现有领域服务，不重写 SQL） |
| issuer 与 GitHub | `oauth_issuers` / `github_installations` / `webhook_deliveries` | issuer 增改禁（见 §8）；GitHub 只读 |
| 系统健康 | `rate_limits` / `pgboss.job` / 各表计数 / DB 可达性 | 无 |
| 发布策略 | `policy.ts` 常量 + `moderation_events` 最近判定 | 无 |

**诚实边界**：`rate_limits` 是固定窗口计数表，无历史事件流 → 只展示当前窗口活跃计数，画不出
趋势；下载失败率无记录点 → 不做。

**`last_admin` 保护**：禁用/删除管理员前检查剩余 active 数量，最后一个拒绝（`last_admin`），
防止误操作锁死系统。

## 8. OAuth2 配置（后台可写）

存储层零改动：`oauth_issuers` 已有 `client_secret_ciphertext` + `client_secret_kid`，keyring
现成；现在的 `ensureBootstrapIssuer` 就是「把 env 的 secret 加密入库」，只是换个写入口。

- 新增：`issuer_key`（`^[a-z0-9][a-z0-9-]{0,31}$`，创建后不可改）、`display_name`、`base_url`
  （生产 https，本地允许 http://127.0.0.1 / localhost）、`client_id`（8..128，provider 的
  `token.request.json` 约束）、`client_secret`（≤256）、`scopes[]`、`status`。
- 编辑：同上，`issuer_key` 只读。写 secret 即轮换（与 provider 单哈希覆盖一致，无双 secret
  宽限；refresh token 绑 client_id，所以轮换不会踢人下线）。
- **secret 永不回显**：列表与详情只显示 `kid` 与更新时间。
- 删除 = 软删（`status='disabled'`），因为 `accounts.issuer_key` 有历史引用；已禁用 issuer 的
  账号仍可读，但不能再登录。
- 测试连接：请求 `{base_url}/api/oauth/csrf` 探活 + 本地校验 client_id 长度，结果写
  `last_verified_at` / `last_error`，只做提示不做闸门。
- 全部写操作：同源检查 + 审计（`admin.issuer.*`）+ 二次确认对话框。

**登录入口联动**（`/api/auth/sforum/start`）：

- 无 active issuer → 303 到 `/?error=no_issuer`，前台显示「管理员尚未配置登录方式」，不 500。
- 多个 active → 登录页列出选择，`?issuer=` 指定；只有一个时自动使用。
- `ensureBootstrapIssuer` 与 `config.bootstrapIssuer` 删除，调用点改为「按 key 读 DB」。

## 9. 权限矩阵

| 路由 | 未登录 | 已登录管理员 | 备注 |
| --- | --- | --- | --- |
| `<adminPath>/login`、`<adminPath>/setup` | 可达 | 重定向到概览 | setup 在已初始化后 404 |
| `<adminPath>/**` 其余 | 303 → login | 200 | 路径不匹配一律 404 |
| `/api/admin/**` | 401 | 200/4xx | 写操作先同源检查 |
| `/moderation/**` | 303 → OAuth | 不变 | 仅 `admin|moderator`（现状） |
| `/dashboard/**` | 303 → OAuth | 不变 | 论坛身份，不受本轮影响 |

越权一律 404（页面）或 403（API 已认证无权限），不泄漏资源存在性。

## 10. 改动清单

**新增**

- `service/src/app/[adminPath]/**`（§4 结构）
- `service/src/lib/admin/`：`guard.ts`（会话读取 + 闸门）、`password.ts`（scrypt）、
  `accounts.ts`、`audit.ts`、`products.ts`、`system.ts`、`issuers.ts`、`setup.ts`
- `service/src/app/api/admin/**`：`session`、`setup`、`accounts`、`accounts/[id]/sessions`、
  `issuers`、`issuers/[key]`、`issuers/[key]/verify`、`audit`、`products/[id]/delist`、
  `versions/[id]/yank`
- `service/src/components/admin/**`（外壳、表格、筛选器、确认对话框）
- `service/drizzle/0006_*.sql`：`admin_accounts`、`admin_sessions`、`audit_log.actor_admin_id`
- `service/scripts/admin-password.ts`
- `service/test/admin-*.test.ts`

**修改**

- `lib/config.ts`：加 `adminPath`、`adminSetupToken`；删 `bootstrapIssuer`
- `lib/auth/service.ts`：删 `ensureBootstrapIssuer` / `grantBootstrapRole`；`loadActiveIssuer`
  改签名
- `app/api/auth/sforum/{start,callback}`：issuer 从 DB 解析，支持 `?issuer=`
- `app/(storefront)/page.tsx`：`no_issuer` 降级提示
- `scripts/seed-dev.ts`：插入 issuer 行与一个本地管理员（密码写死仅供 dev）
- 9 个测试文件的 `STORE_BOOTSTRAP_ISSUER` fixture → 改成插库 helper
- `AGENTS.md`（边界 1/7 改写 + 后台约定）、`docs/deployment.md`（部署顺序、setup token、
  `STORE_ADMIN_PATH`）、`docs/plugin.md`（登录入口变化）

**不动**：`contracts/store-api.yaml`（admin API 是内部面，不进跨产物契约）、`plugin/`、
下载链路、审核流领域服务。

## 11. 测试计划

- 注册：token 缺失/错误/正确、已初始化后再访问 404、并发双注册只成功一次
- 密码：长度边界、与用户名相同、哈希格式自描述、锁定与解锁、失败审计
- 会话：TTL、强制下线、多设备、cookie 属性（HttpOnly/Secure/SameSite/`__Host-` 前缀条件）
- 权限：每条 `/api/admin/**` 都有 401 + 200 两个用例；页面越权 404
- 路径：`STORE_ADMIN_PATH` 变更后旧路径 404；保留前缀冲突启动失败；单段校验
- issuer：创建/编辑/禁用、secret 不回显、轮换后旧密文不残留、client_id 长度校验、
  `last_verified_at` 写入
- `last_admin` 拒绝
- 产品：强制下架、yank 影响下载（旧 token 410）
- 审计：筛选与游标分页、`actor_admin_id` 写入
- 回归：全量 `bun test --parallel=1` 保持 0 fail；`tsc --noEmit` 干净；`bun --bun next build` 通过

## 12. 验收

1. 空库冷启动演练：配 setup token → 注册首个管理员 → 登录 → 配 issuer → 用论坛账号 OAuth
   登录 `/dashboard` 成功。
2. 六个模块逐页可读；写操作有确认、有审计、有 Toast。
3. 视觉证据：1633×810 与 390×844 各一套（对齐、溢出、可访问名称）。
4. `STORE_ADMIN_PATH=/ops` 重启后 `/ops` 可用、`/admin` 404。
5. 全量测试与构建绿。

## 13. 风险与取舍

| # | 风险 | 处置 |
| --- | --- | --- |
| 1 | 打破 AGENTS.md 边界 1/7 | 同轮改写文档，决策记录留档；不是遗忘而是明示取舍 |
| 2 | setup token 泄露 = 后台被抢注 | 一次性、成功后入口关闭、可轮换；未配置时注册能力直接关闭 |
| 3 | 密码成为新攻击面 | scrypt + 12 字符下限 + 5 次锁 15 分钟 + 独立限流通道 + 全量审计 |
| 4 | 废弃 env issuer 后首次部署步骤变长 | `docs/deployment.md` 写成有序步骤；无 issuer 时前台优雅降级不 500 |
| 5 | 管理员与论坛用户是两行账号，易混淆 | 文档写明；后台「账号与角色」分两个区块展示 |
| 6 | 路径可配置被误当安全措施 | 文档与代码注释都写明「混淆不是防护」 |
| 7 | `store_roles.role='admin'` 旧行不生效，可能让人以为还有权限 | 迁移不改数据；后台账号页对旧行显示「已废弃，不生效」 |

## 14. 交付方式

**一次交完整 v1**（人工确认）。顺序：数据模型与迁移 → 密码/会话/setup → 路径与外壳 →
issuer 配置 → 四个只读模块 → 全局产品写操作 → 文档与视觉验收。

> **进度（2026-10-25）**：v1 已交付。迁移 `0006_wooden_cable`；管理员身份、路径配置、setup
> 认领、OAuth2 后台配置、六个模块全部落地；`STORE_BOOTSTRAP_ISSUER` / `STORE_BOOTSTRAP_ADMINS`
> 删除，`lib/auth/service.ts` 的 bootstrap 播种函数一并移除。全量 **350 pass / 0 fail / 35 files**
> （基线 312），`tsc` 干净，`bun --bun next build` + `next start` 下 7 个页面实测 200。
> 交付中发现并修掉两处计划未预见的问题：① 窄屏三张表横向溢出（已按断点收列）；② 自动发布
> 在 `moderation_events` 里没有痕，导致「最近判定」全是人工通过（已补 `auto_published`）。
> 计划状态仍为 `active`，**转 `completed` 需人工验收**。细节见
> `sessions/2026-10-25-admin-console.md`。
