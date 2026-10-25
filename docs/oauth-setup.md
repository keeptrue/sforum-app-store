# 接入 SForum 登录（OAuth2）

商城不自己做注册，论坛用户凭 **SForum 的 OAuth2 提供方**（插件 `sforum-oauth2-provider`）登录。
本文是**论坛管理员**的作业单：先在论坛建一个 OAuth2 应用，再把四个值填进商城后台。

- 商城侧入口：`${STORE_PUBLIC_URL}/${STORE_ADMIN_PATH}/settings/issuers`（默认 `/admin/settings/issuers`）。
- 论坛侧入口：论坛后台 → 分组 **OAuth2** → **OAuth2 应用**（插件路由 `/clients`）。
- 一个商城**只接入一个论坛**（一个启用中的 issuer）。理由与取舍见
  `knowledge/decisions/2026-10-24-app-store-identity-and-distribution.md`。

## 1. 前置

| 条件 | 检查方式 |
| --- | --- |
| 论坛已安装并启用 `sforum-oauth2-provider` | 论坛后台能看到「OAuth2」分组；`curl -i https://<论坛>/api/oauth/csrf` 不是 404 |
| 商城对外地址已是最终地址 | 回调地址由**生效地址**推导（后台「系统设置」保存的值 > `STORE_PUBLIC_URL` 种子）。改域名在后台改，保存即生效；论坛里登记的回调地址要同步改 |
| 商城有管理员账号 | 空库先走 `STORE_ADMIN_SETUP_TOKEN` 注册（见 `deployment.md`） |

## 2. 在论坛建应用（8 步）

1. 论坛后台 → **OAuth2** → **OAuth2 应用** → **新建应用**。
   权限：`sforum.oauth2-provider.manage_clients`（管理员默认有）；站点开着「允许用户自助创建应用」
   时，持 `sforum.oauth2-provider.create_clients` 的登录用户也能建自己的应用。
2. **应用名称**：填商城名，例如 `应用商城`。它会显示在用户授权确认页上（≤120 字符）。
3. **客户端类型**：选 **机密（confidential）**。
   商城在服务端换 token 并持有 `client_secret`；公开客户端（public）没有密钥，接不上。
4. **回调地址**：填 **`${STORE_PUBLIC_URL}/api/auth/sforum/callback`**，逐字一致。
   例：`https://store.example.com/api/auth/sforum/callback`；本地开发
   `http://127.0.0.1:4000/api/auth/sforum/callback`。
5. **权限范围**：勾 `profile` + `avatar`；需要邮箱再加 `email`。见 §4。
6. **创建**后立刻复制 `client_id` 与 `client_secret`——密钥只显示这一次。
7. 回到商城后台 **新增 issuer**，填 §3 的五个字段，保存后点 **测试连接**。
8. 用论坛账号打开 `${STORE_PUBLIC_URL}/dashboard`，走完一次登录。

## 3. 字段对照

| 商城后台字段 | 从论坛哪里拿 | 约束（provider 侧） |
| --- | --- | --- |
| `issuer_key` | 自己起名，如 `official` | `^[a-z0-9][a-z0-9-]{0,31}$`，创建后不可改；账号唯一键是 `(issuer_key, sub)` |
| 显示名 | 自己起名，如 `官方论坛` | 仅后台展示 |
| 论坛地址 `base_url` | 论坛根地址 | 生产 `https`；本地 `http://127.0.0.1` / `http://localhost`；**不带路径** |
| `client_id` | 应用创建后显示 | 形如 `sfo_client_` + 24 位十六进制（35 字符）；provider schema 要求 8..128 |
| `client_secret` | 应用创建后**只显示一次** | 形如 `sfos_` + 64 位十六进制（69 字符）；≤256 |
| `scopes` | 与第 5 步勾选一致 | 必须 ⊆ 站点 `allowed_scopes`，且 ⊆ 该应用登记范围 |

`issuer_key` 只是账号归属的内部键，不参与任何网络请求；论坛换域名不改它，因此账号不会漂移。

## 4. 权限（scope）怎么选

商城的 userinfo 映射只读这几个字段：`sub` / `username` / `displayName` / `avatar` / `email` /
`emailVerified`。据此：

| scope | 勾不勾 | 商城拿它做什么 |
| --- | --- | --- |
| `profile` | **必选** | 身份基底：用户名、昵称、注册时间、账号状态。账号键 `(issuer_key, sub)` 靠它 |
| `avatar` | **勾选** | 头像地址写进 `accounts.avatar_url`；不勾就是默认头像 |
| `email` | 可选 | 邮箱与验证状态；授权时读取一次存快照。论坛需已授予 `users.email.read` 能力 |
| `topic.count` | 不要勾 | 主题数，商城不读 |
| `comment.count` | 不要勾 | 回帖数，商城不读 |
| `users.groups` | 不要勾 | 用户组徽章，商城不读（商城角色来自本地 `store_roles`） |

三层约束，从内到外：

1. **应用登记范围**是这次授权能申请的**上限**，也是商城不带 `scope` 时的默认值（RFC 6749 §3.3）。
   勾少了 → 商城请求 `profile avatar` 时收到 `invalid_scope`。
2. **站点 `allowed_scopes`**（论坛后台 → OAuth2 → OAuth2 设置）是硬上限，默认
   `email avatar topic.count comment.count users.groups`，`profile` 恒并入。
3. 商城后台填的 `scopes` 必须落在前两层之内。

## 5. 回调地址规则与常见错法

provider 做**精确匹配**（`backend/oauth2.go#matchRedirectURI`）：不做通配、不做路径前缀匹配、
不接受 `#fragment`；一个应用最多登记 10 个。

| 错法 | 结果 |
| --- | --- |
| 结尾多了 `/`（`…/callback/`） | 不匹配 → 授权页报错，无法回跳 |
| 填商城首页或 `/dashboard` | 同上 |
| 生产填 `http://…` | 登记阶段就被拒（只放行 https 与回环 http） |
| 填 `https://…:443/…` 而商城生成的是默认端口 | 字符串不同 → 不匹配 |
| 改过商城对外地址（后台「系统设置」，或首启前的 `STORE_PUBLIC_URL`）却没改论坛里的登记 | 同上；两边必须同时改 |

## 6. 失败码

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `invalid_client` | `client_id` 不存在，或 `client_secret` 不匹配 | 核对两个值；重置过密钥要同步更新 |
| `invalid_scope` | 请求范围超出应用登记范围或站点 `allowed_scopes` | 论坛里补勾，或把商城 `scopes` 收窄 |
| `invalid_grant` | 授权码过期/已用、`redirect_uri` 与授权请求不一致、PKCE 失败 | 重走登录；核对回调地址 |
| 422 `extensions.route_schema_invalid` | 请求体违反 provider 的 JSON schema：`client_id` 短于 8 字符、发了空字符串字段、用了表单编码 | 修 `client_id`；不要在可选字段发空串 |
| 403 `oauth2.client_creation_forbidden` | 建应用的人没有权限 | 用管理员建，或授予 `create_clients` |
| 403 `oauth2.client_creation_disabled` | 站点关闭了「允许用户自助创建应用」 | 管理员建，或在 OAuth2 设置里打开 |
| 后台「测试连接」报 404 | 地址可达但没有 `/api/oauth/csrf` | 论坛没装/没启用该插件 |

## 7. 轮换 client_secret

provider 是**单哈希覆盖**：没有双 secret 宽限，重置后旧密钥立即失效。

1. 论坛后台 → OAuth2 应用 → **重置密钥** → 复制新密钥。
2. 商城后台 → 编辑 issuer → `client_secret` 填新值 → 保存（留空表示不修改）。
3. 滚动重启商城（`bun run start` 的进程）。

刷新令牌绑 `client_id` 而不是 secret，所以轮换**不会**把已登录用户踢下线；他们下一次刷新
token 时用新 secret 即可。

## 8. 换论坛（单 issuer 口径）

一个商城只接入一个论坛。要换：

1. 商城后台停用当前 issuer（软删：行保留，`accounts.issuer_key` 仍指向它）。
2. 在新论坛按 §2 建应用，回后台新增 issuer 并启用。
3. 旧论坛的账号与商品归属**不合并**：它们仍挂在旧 `issuer_key` 下，需要人工转移或下架。

停用后、新增前，前台会显示「还没有配置登录来源」，不会 500。

## 9. 为什么标准 OAuth 库接不上

`sforum-oauth2-provider` 的所有路由都在**宿主的 CSRF 中间件之后**，且请求体由宿主按 schema
先校验。因此：

- 先 `GET /api/oauth/csrf` 拿 `csrf_` cookie，再带 `X-Csrf-Token` 与 `Origin: <论坛源>` 发 POST。
  直接用 `openid-client` / `passport` 之类的标准库会在第一步吃 403。
- 请求体必须是 `application/json`（`additionalProperties: false`，字段有 min/max 长度）；
  `application/x-www-form-urlencoded` 会被 422 `extensions.route_schema_invalid` 拒掉。
- 客户端凭据只能放 **JSON 请求体**：宿主以 filtered authority 交付，`Authorization` 头到不了插件路由。
- `userinfo` 只认 `access_token` **查询参数**（不读 `Authorization`），响应字段是 camelCase：
  `sub` / `username` / `displayName` / `avatar` / `email` + `emailVerified`。
- 授权码带 PKCE（S256，base64url 无填充）；provider 侧 PKCE 是可选的，但商城总是发送。

商城实现见 `service/src/lib/oauth/provider.ts`，契约细节来自 `openapi/routes.yaml` 与
`schemas/*.json`。**未验证**：一次带真实论坛用户会话的完整登录（当前只在本地 fake provider 上
跑通）；验证方式是用真实论坛凭据走 `/dashboard` 并观察 `auth.login.succeeded` 审计行。
