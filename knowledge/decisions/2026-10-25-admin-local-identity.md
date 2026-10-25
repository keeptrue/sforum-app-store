# 管理员本地身份：与论坛身份彻底隔离

Status: accepted
Date: 2026-10-25

## 背景

商城的全部身份原本只来自 SForum OAuth2：`accounts(issuer_key, sub)` 唯一，角色在
`store_roles`，管理员由 `STORE_BOOTSTRAP_ADMINS` 在登录时授予。这带来两个问题：

1. 商城没有论坛就完全无法运营 —— 审核台、issuer 配置、系统状态都挂在论坛可用性上。
2. OAuth2 提供方本身需要配置（`client_id` / `client_secret` / 回调地址），而这个配置只能走
   env + 重启，改一次要动部署。

2026-10-25 决定：管理员改为**商城本地账号**（用户名 + 密码），OAuth2 issuer 改为**后台可配**。
这是架构变更，不是增量功能。

## 决定

### 1. 管理员是独立主体，不进 `accounts`

新表 `admin_accounts` + `admin_sessions`。**不给 `accounts` 加 `password_hash`**。

理由：`accounts` 的语义是「论坛身份」，键是 `(issuer_key, sub)`。把本地密码塞进去需要一个
伪造的保留 issuer，并让「谁是管理员」同时存在两种来源（本地密码 / 论坛 sub 命中白名单）。
安全审查时这两条路径必须各自证明，成本高于隔离。

代价：同一自然人若既是管理员又要发布扩展，会有两行账号；后台「账号与角色」因此分两个区块
展示（管理员 / 论坛账号）。这是明示取舍。

### 2. 两条身份线互不授予

- OAuth 账号**永远**不是 admin；`store_roles.role='admin'` 废弃，旧行保留但不参与鉴权。
- 本地管理员**不**进开发者门户（`/dashboard`），也不持有论坛 token。
- `STORE_BOOTSTRAP_ADMINS` 与 `grantBootstrapRole` 删除。

### 3. 密码用 scrypt，不用 Bun.password

`node:crypto` 的 scrypt（N=32768, r=8, p=1, keylen=64，16 字节盐，实测约 92 ms），存储格式
`scrypt$N$r$p$salt_b64$hash_b64` 自描述，便于日后提参数而不破坏旧哈希。

不用 `Bun.password`：`next start` 回退 Node 时 Bun 全局不存在（`AGENTS.md`「运行时闸门」允许
这条回退），密码校验不能依赖只在 Bun 下存在的 API。

### 4. `STORE_BOOTSTRAP_ISSUER` 废弃，issuer 全部由后台配置

`oauth_issuers` 表已有 `client_secret_ciphertext` + `client_secret_kid`，keyring 现成 ——
`ensureBootstrapIssuer` 原本就是「把 env 的 secret 加密入库」，所以后台配置只是换一个写入口，
存储层零改动。

后果：首次部署多两步（配 setup token → 注册管理员 → 配 issuer）。无 active issuer 时前台
登录入口必须优雅降级，不能 500。

### 5. 后台路径可配，但不作为安全措施

`STORE_ADMIN_PATH`（默认 `/admin`），单段、启动校验、与保留前缀冲突即失败。实现用顶层动态段
`app/[adminPath]/`，不用 `proxy` 重写 —— 依据 Next 16.4.3 源码：`middleware` 已改名 `proxy`
且固定 Node 运行时，能满足「请求时读 env」，但要额外封死内部真实路径，多一层易错规则；
动态段没有这个问题，且真实嵌套 layout 与 404 语义都保住。

路径是混淆，不是防护。真正的边界是会话与账号存在性检查，这条写进 `AGENTS.md`。

### 6. 首个管理员靠一次性 setup token

`STORE_ADMIN_SETUP_TOKEN` 未配置时注册能力**直接关闭**（页面显示生成命令），而不是「不设防
放行」。理由：手动注册把接管窗口从「论坛注册用户」扩大到「任何能访问公网 URL 的人」，比
OAuth 方案更危险，必须有第二因素。

注册成功判据是「存在 admin 行」，不需要额外状态位；之后 `/setup` 一律 404。并发用
`pg_advisory_xact_lock` + 事务内二次检查。

## 放弃的方案

- **复用 `accounts` + 保留 issuer `local`**：链路复用最省事，但让管理员身份有两种来源。
- **env issuer 只读、后台只能新增**：仍然要改 env 才能改主 issuer，没解决原问题。
- **首次注册不设防**：公网服务等于把后台送人。
- **`proxy` 重写内部固定路径**：多一层「内部路径必须封死」的规则，收益只是 URL 结构整齐。
- **TOTP / 邮件找回**：v1 无邮件设施；二次验证留后续，先靠限流 + 锁定 + 审计。

## 代价与重开条件

- `AGENTS.md` 边界 1（无注册无密码）与边界 7（角色不来自论坛用户组）必须改写；这是明示取舍，
  决策记录留档。
- 首次部署步骤从 2 步变 5 步（`docs/deployment.md`）。
- 管理员密码成为新的攻击面：12 字符下限 + 5 次锁 15 分钟 + 独立限流通道 + 全量审计。
- 若将来需要「管理员同时是论坛用户」，再评估账号合并（需要迁移脚本与身份绑定流程）。

## 实施补记（2026-10-25，遗留 admin 行）

决策写下「`store_roles.role='admin'` 已废弃，旧行保留但不参与鉴权」，但代码当时没兑现：
`getRoles` 原样返回所有行，审核台的页面门与接口门都把 `admin` 算作放行角色，于是 S1 bootstrap
留下的那一行实际还在开审核台。现在按本条决策收紧：

- `CurrentSession.roles` 的类型是 `ActiveStoreRole = "moderator"`，越权写法在编译期就过不去。
- `getRoles` 在 SQL（`role = 'moderator'`）与 TS（类型守卫 filter）两层过滤 `admin`。
- `app/moderation/page.tsx` 与 `lib/moderation/service.ts` 的 `MODERATOR_ROLES` 只留
  `moderator`；`routes.test.ts` 用「遗留 admin 行 → 403」把这条锁成回归用例。

旧行仍保留在库里（历史证据），但已经不影响任何鉴权路径。清库脚本与现场处置见
`sessions/2026-10-25-legacy-admin-role-and-seed-subjects.md`。
