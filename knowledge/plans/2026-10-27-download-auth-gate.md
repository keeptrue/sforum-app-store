# 商城安装登录闸门（下载签发前必须登录）

Status: **ready（2026-10-27 批准；新对话开工）**
Started: 2026-10-27
Approved: 2026-10-27
Repos: `sforum-app-store` + SForum core
Related: `plans/2026-10-24-app-store-service.md` §5.6（当前匿名签发）、`decisions/2026-10-26-install-gate.md`（页面级安装门禁）

## 0. 结论先行

能实现，而且不需要把商城逻辑写进 core。推荐把闸门放在**下载签发**这一层，而不是字节分发：宿主的 `install-from-url` 只拿一个签名 URL，不携带浏览器凭据；签名 URL 本身仍是 bearer，TTL 30 分钟。签发点验身份，是唯一能同时覆盖「插件页安装」和「商城前台下载」的位置。

| 决策 | 选择 |
| --- | --- |
| 闸门位置 | 下载签发（目录仍匿名可浏览） |
| 覆盖范围 | 所有下载：插件页安装 + 商城前台产品页 |
| 登录身份 | 任何能进该管理页的论坛账号；页面收紧到 `extension.plugin.manage` |
| 登录载体 | 新标签商城授权页 `/connect/{id}` + 插件后端轮询 |
| 令牌持有 | 插件 Go 后端；30 天；写入宿主加密 secret 设置 |
| Core 改动 | 新增 `SecretService.Put/Clear`，只允许写清单声明的 secret 字段 |
| 上线方式 | `download_auth_mode` 运行时开关，默认 `anonymous`，升级插件后手动切 `account_required` |

**执行方式：单 agent 顺序执行。** §10 给出阶段顺序与每阶段出口；先做 P0/P1，P1 完成后再动 P2。

**推荐理由**

1. 宿主安装器只认 URL，不认 Cookie/Authorization；签发点是唯一能验账号的关口。
2. 插件页是宿主同源的受信 ESM，不是 iframe；它能开新标签、能调自己的后端，但商城与插件之间没有 CORS，也不该为这件事开 CORS。
3. 后端持有长期令牌必须有加密落点。宿主已有 `SecretStore` + `SettingsLifecycle`（secret 字段加密、设置页只显示 `secretSet`），缺的只是「插件写自己 secret 设置」的半个 API；补这一块是通用能力，不是商城专用 hook。
4. 这符合 `decisions/2026-10-24-app-store-out-of-tree.md`：core 只长通用原语，商城产品逻辑留在商城仓。

**代价（必须写进文档）**

- 令牌是**论坛级**，不是管理员级。审计记「哪个商城账号授权了这台论坛」，不记「哪个管理员点的安装」。要按管理员归属，需要 core 的 actor 上下文 + 实例断言，留到 Tier 2。
- 签名 URL 在 30 分钟内仍是 bearer；拿到链接的人可以下载。闸门拦的是「拿链接」，不是「字节」。
- 旧插件遇到 `account_required` 会收到 401，页面只能显示「商城暂时不可用」；所以默认 `anonymous`，切换前必须先升级插件。

## 1. 目标与成功标准

**目标**

1. `account_required` 模式下，匿名 `POST /api/v1/download-urls` 返回 401；带有效令牌返回 200。
2. 插件页可以「连接商城」：新标签打开商城授权页，登录论坛账号并允许；插件后端拿到令牌，写入宿主加密 secret 设置。
3. 连接一次后，论坛重启、页面刷新、管理员换人，安装都不再要求登录；30 天后或撤销后重新连接。
4. 商城前台产品页的「下载」同样要求登录；登录后回到下载路由并拿到文件。
5. 旧插件 + `anonymous` 模式行为不变；新插件 + 旧商城隐藏连接 UI；新插件 + 旧 core 由 `sforumVersion` 拦下安装。
6. 令牌不以明文出现在设置页、日志、审计、API 响应或数据库明文中。

**成功标准**

- 匿名签发 401 `login_required`；有效令牌 200；宿主真实安装成功。
- 插件页连接一次后，重启宿主仍能安装；断开后安装重新要求连接。
- 商城前台未登录点下载 → 登录 → 文件开始下载。
- `download_auth_mode` 切回 `anonymous` 后旧插件恢复可用。
- 全量测试、typecheck、Go vet/test、插件前端测试、`build.sh`、`manifest:check`、`capabilities:check` 全绿。
- 1633×810 与 390×844 两档截图：插件连接条、商城授权页、商城前台下载提示。

**非目标（v1 不包含）**

- 目录登录墙；目录继续公开。
- SSO / 实例断言 / 免二次登录。
- 按管理员归属的安装审计。
- 商城专用 core API、商城 OAuth 客户端注册、宿主代管令牌。
- 自动启用/信任扩展；安装语义仍是「已暂存」。

## 2. 现状与硬约束

- **当前签发匿名**：`service/src/lib/download/issue.ts` 明确「published = anyone may install」；插件后端 `upstream.go` 调 `/api/v1/download-urls` 不带凭据。
- **宿主 `settings.own` 只有读**：`sforum.extensions.settings.own` 查询返回解密后的设置；`SecretService.Resolve` 只读；没有写 secret 的 Host API。
- **secret 设置已经加密**：`SettingsLifecycle.Put` 把 secret 字段写进 `SecretStore`，设置文档只存 `sforum.secret://` 引用；设置页只显示 `secretSet`，不回显值。
- **插件页是受信 ESM**：`SFTrustedAdminPageComponent.vue` 直接挂载，不是 iframe；`bridge.request` 会过滤 `Authorization` 头，所以令牌不走页面 → 后端的 header，而是后端自己持有。
- **宿主路由上下文不含 actor/permissions**：插件后端不知道「谁点的安装」；这也是论坛级令牌的原因。
- **商城没有 CORS**：插件页与商城之间没有直达通道；所有商城调用走插件后端。
- **商城单 issuer**：一个商城只接一个论坛；授权页用现有 `/api/auth/sforum/start` 登录。
- **签名 URL 是 bearer**：`/api/v1/download/{token}` 不验会话；`downloadMode=proxy|redirect` 不变。
- **插件路由可以收紧**：`core.guard.permission` + `extension.plugin.manage`；当前三条路由都是 `core.guard.login`，catalog 页也没有 `permission` 字段。
- **前端预算**：`catalog.css` 当前约 18.1 KB（发布产物），计划 §7.5 的 20 KB 是复查线；连接 UI 要复用现有类，超出时按计划修订预算并记录理由。
- **本地起服务**：`bun run dev` 已是 supervisor（web + worker），停止用 `bun run dev:stop`；Next 16.4 的 `lockDistDir` 锁决定同一 checkout 不并行起第二个 dev（见 `decisions/2026-10-27-dev-supervisor-and-lock.md`）。E2E 按这个姿势跑。

## 3. 目标流程

### 3.1 插件页连接（新标签 + 后端轮询）

1. 页面挂载 → `GET /api/store/auth/status`。
2. 插件后端读 secret 设置，并调商城 `GET /api/v1/auth/mode`（60 秒缓存）。
3. `mode=account_required` 且未连接 → 目录顶部显示连接条；安装按钮文案「登录后安装」。
4. 点击「连接商城」：同步 `window.open('about:blank', '_blank')`，设置 `tab.opener = null`；再调 `POST /api/store/auth/start`。
5. 插件后端生成 PKCE verifier/challenge，调商城 `POST /api/v1/auth/requests`，返回 `{requestId, verifier, authorizeUrl, expiresIn, interval}`；后端校验 `authorizeUrl` 的 origin 等于配置的商城地址。
6. 页面把 tab 导航到 `authorizeUrl`，每 2 秒 `POST /api/store/auth/poll {requestId, verifier}`。
7. 商城 `/connect/{id}`：未登录先跳 `/api/auth/sforum/start?redirect=/connect/{id}`；登录后显示账号、issuer、请求来源，点「允许」。
8. 插件后端轮询到 `approved` → 调商城 `POST /api/v1/auth/requests/{id}/token {code_verifier}` → 拿到 `{access_token, expires_at, account}`。
9. 插件后端调宿主 `SecretService.Put`，把 `{token, expiresAt, account}` 写进 secret 设置 `sforum.store.account_token`；失败则尽力调商城 revoke 并返回 `secret_write_failed`。
10. 页面显示「已连接为 @x」；安装条恢复可用。授权页显示「已允许，可关闭此页」。

### 3.2 安装

1. 页面 `POST /api/store/install-url`（请求体不变）。
2. 插件后端读 secret；`account_required` 且无令牌 → 401 `login_required`。
3. 有令牌 → 调商城 `POST /api/v1/download-urls`，带 `Authorization: Bearer <token>`。
4. 商城校验令牌/账号/scope → 签发签名 URL → 写 `download.issued` 审计。
5. 插件后端返回 `{url, sha256, size, expiresAt}`；页面照旧调 `bridge.installExtension` / `installAndEnableExtension`。宿主下载与暂存逻辑不变。

### 3.3 商城前台下载

1. 产品页「下载」链接到 `GET /api/v1/products/{slug}/download/{os}/{arch}`。
2. `account_required` 且无商城会话 → 302 到 `/api/auth/sforum/start?redirect=<同一路径>`。
3. 登录回调 303 回同一路径；路由检查会话后 302 到签名 URL。
4. 浏览器开始下载。产品页按钮在未登录时显示「下载（需登录）」，登录后正常。

### 3.4 断开与失效

- 插件页「断开连接」→ `POST /api/store/auth/disconnect` → 插件后端调商城 `POST /api/v1/auth/revoke`（尽力）→ `SecretService.Clear`。
- 商城返回 401（过期/撤销/账号停用）→ 插件后端清 secret，`install-url` 返回 `login_required`；页面显示「连接已失效，请重新连接」。
- 令牌 30 天过期；商城侧可撤销账号全部令牌（P1 管理台入口）。

## 4. 商城服务端

### 4.1 数据模型（迁移 `service/drizzle/0015_install_auth.sql`）

**`install_auth_requests`**

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid PK | 授权请求 id，出现在 `/connect/{id}` |
| `code_challenge` | text not null | S256 challenge，base64url |
| `client_label` | text | 插件上报的展示名，≤64 字符，不可信 |
| `status` | enum | `pending / approved / denied / consumed / expired` |
| `account_id` | uuid null | 批准后的商城账号 |
| `expires_at` | timestamptz | 5 分钟 |
| `interval_seconds` | int | 默认 2 |
| `created_ip` / `user_agent` | text | 审计与限流 |
| `approved_at` / `consumed_at` | timestamptz | 状态时间 |
| `created_at` | timestamptz | |

索引：`(status, expires_at)`、`created_at`。

**`account_tokens`**

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid PK | |
| `account_id` | uuid not null → accounts | |
| `token_hash` | text unique | SHA-256(`sfo_...`) |
| `scope` | text | `download:issue` |
| `expires_at` | timestamptz | 30 天 |
| `revoked_at` | timestamptz null | |
| `client_label` | text | 来源展示 |
| `created_ip` / `user_agent` | text | |
| `last_used_at` | timestamptz | 节流更新 |
| `created_at` | timestamptz | |

索引：`account_id`、`expires_at`。

**`store_settings.download_auth_mode`**：text null；运行时解析 `行 > STORE_DOWNLOAD_AUTH_MODE > anonymous`。

### 4.2 API（`contracts/store-api.yaml` + 路由）

| 方法/路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /api/v1/auth/mode` | 匿名 | `{mode: anonymous\|account_required, token_ttl_seconds}`；no-store |
| `POST /api/v1/auth/requests` | 匿名 + IP 限流 | body `{code_challenge, client_label?}`；返回 `{id, authorize_url, expires_in, interval}`；无 issuer → 503 |
| `GET /api/v1/auth/requests/{id}` | 匿名 + 请求限流 | 只返回 `{status}`，不泄露账号 |
| `POST /api/v1/auth/requests/{id}/token` | 匿名 + 请求限流 | body `{code_verifier}`；校验 PKCE、一次性；返回 `{access_token, token_type, expires_in, expires_at, scope, account}` |
| `GET /api/v1/auth/me` | Bearer | `{account, expires_at, scope}` |
| `POST /api/v1/auth/revoke` | Bearer | 撤销当前令牌；幂等 204 |
| `POST /api/v1/download-urls` | 条件 Bearer | `account_required` 时必须有有效令牌；401 码：`login_required / token_expired / token_revoked / account_disabled / insufficient_scope` |
| `GET /api/v1/products/{slug}/download/{os}/{arch}` | 条件会话 | `account_required` 且无会话 → 302 登录；有会话 → 302 签名 URL |

授权页 `GET /connect/{id}` 与决策 `POST /api/connect/{id}/decision`（同源 + 会话）走页面/表单路由，不进公开 API 契约。

**限流通道**：`install-auth-start`（IP 10/300）、`install-auth-poll`（请求 id 120/300，2 秒最小间隔）、`install-auth-token`（请求 id 10/300）、`download-account`（账号 60/300）；`download-ip` 保留。新增 env/default 与后台限流面板行。

**审计**：`auth.install_request.approved`、`auth.install_token.issued`、`auth.install_token.revoked`、`download.issued`（actor_account_id + product/version/os/arch/mode）、`settings.download_auth_mode.changed`。任何 details 都不含令牌、verifier、签名 URL。

### 4.3 授权页 `/connect/{id}`

- 位置：`service/src/app/(auth)/connect/[id]/page.tsx`，最小壳（品牌 + 卡片），不复用三面外壳。
- 未登录 → `redirect('/api/auth/sforum/start?redirect=/connect/' + id)`；`safeRedirect` 已允许该路径。
- 显示：商城账号 `@username`、issuer 显示名、插件上报的 `client_label`、请求短码；提示「只在你刚点过『连接商城』时允许」。
- 允许/驳回：表单 POST 到 `/api/connect/{id}/decision`；`isSameOrigin` + SameSite=Lax；条件更新 `where status='pending'`；成功后回 `/connect/{id}?done=approved|denied`。
- 状态：pending / approved / denied / expired / consumed 各有文案；过期显示「回到论坛重新发起」。
- 换账号：提示先在论坛退出再登录；不做商城侧账号切换。
- `Cache-Control: no-store`。

### 4.4 强制与设置

- `RuntimeConfig.downloadAuthMode` + `downloadAuthModeSource`；`getRuntimeConfig` 15 秒缓存；`/api/health` 回报。
- 后台 `/<adminPath>/settings/general` 新增「下载分发」单选：匿名 / 需要商城账号；保存时 `recordAudit`；切换为 required 时显示警告「先把所有站点的 sforum.store 升级到支持登录授权的版本；旧插件会收到 401」。
- `download-urls`：`account_required` 时读 Bearer，SHA-256 查 `account_tokens`，校验未撤销、未过期、账号 `active`、scope 含 `download:issue`；通过后签发；节流更新 `last_used_at`。`anonymous` 时无令牌照旧；带令牌则校验并审计，无效令牌忽略。
- 浏览器下载路由：`account_required` 时用 `readSessionCookie` + `findSession`；无会话 302 登录；有会话 302 签名 URL。
- 账号停用/删除：级联或显式撤销 `account_tokens`；后台账号表加「撤销安装令牌」（P1）。

### 4.5 商城前台

- `components/storefront/product-view.tsx` 的下载链接保持指向浏览器路由；页面 SSR 读 `downloadAuthMode` 与会话，未登录且 required 时按钮文案「下载（需登录）」，并给一句说明。
- 目录、详情、搜索保持匿名。

### 4.6 Worker

- 新增每日任务 `install-auth-cleanup`（04:37 UTC，避开 brand sweep）：删除 24 小时前的 `install_auth_requests`、过期 30 天以上的 `account_tokens`；日志只写数量。

### 4.7 契约与类型

- `contracts/store-api.yaml`：新增 `bearerAuth` securityScheme、六个 auth 端点、`401` 响应、`DownloadUrlRequest` 的鉴权说明；`bun run contract:generate` 更新 `service/src/lib/api-types.ts`。
- 契约描述明确「签发是账号级；签名 URL 仍是 30 分钟 bearer」。

### 4.8 测试

- 单测：PKCE、请求状态机、一次性兑换、令牌哈希/过期/撤销/scope、mode 解析、401 矩阵、限流、审计。
- PG 集成：创建 → 批准 → 轮询 → 兑换 → 签发 → 下载；匿名 401；过期/撤销 401；匿名模式 200；浏览器路由会话/无会话；审计行；CSRF/同源。
- 契约：`contract:generate` 无 diff；OpenAPI 校验。
- 前台：产品页下载文案与登录跳转。

## 5. 插件

### 5.1 清单与权限

- `permissions` 增加 `extension.plugin.manage`（当前只有 `extension.view`）。
- catalog 页增加 `permission: "extension.plugin.manage"`，与 settings 页一致；`extension.view` 用户不再看到安装页（这是行为变化，写进发布说明）。
- 四条现有路由 + 四条新路由统一：`access: "permission"`、`guard: "core.guard.permission"`、`permission: "extension.plugin.manage"`；OpenAPI 同步 `x-sforum-guard` / `x-sforum-permission`。
- `sforumVersion` 从 `>=3.0.17` 提到「第一个包含 `SecretService.Put` 的 SForum 版本」；具体版本在 core PR 落地时写死，CI 的 SForum checkout ref 同批移动。
- 新增路由：`sforum.store.route.auth-status`、`auth-start`、`auth-poll`、`auth-disconnect`。
- `manifest/settings.json` 新增 secret 字段 `sforum.store.account_token`（label「商城登录令牌」），说明「由插件在商城授权后自动写入；手动填写只用于迁移」；新增 callout。

### 5.2 Go 后端

- 新文件 `backend/auth.go`：PKCE 生成、商城 auth 客户端（create/status/token/mode/me/revoke）、`handleAuthStatus/Start/Poll/Disconnect`、secret 读写、60 秒缓存、401 清理。
- `settings.go`：`Fields` 加 secret 键；解析 JSON `{token, expiresAt, account}`；写后失效缓存。
- `handlers.go`：`handleInstallURL` 读 secret；`account_required` 无令牌 → 401 `login_required`；带 Bearer 调商城；401 → 清 secret + `login_required`；`installURLFailure` 增加 401 分支（当前 4xx 一律映射 404 `asset_not_found`，必须改）。
- `upstream.go`：`downloadURL` 支持 `Authorization`；新增 auth 请求；错误 reason 不含 URL/令牌。
- `routes.go`：四个新 route id 与 schema 绑定。
- 日志：令牌、verifier、签名 URL 一律不进日志；`failureResponse` 只写路由 id、错误码、短原因。

### 5.3 管理页

- 新文件 `frontend/admin/src/auth.ts`：连接状态机（status → idle/connecting/waiting/connected/error）、2 秒轮询、超时/取消、断开、错误映射；`window.open('about:blank')` 同步开窗 + `opener=null`。
- `catalog.ts`：挂载时并行取目录与 auth status；required 且未连接时显示顶部连接条；安装按钮「登录后安装」/「等待商城授权…」；连接后恢复。
- `copy.ts`：zh-CN/en-US 新增连接、等待、失败、断开、旧商城、旧宿主文案。
- `types.ts` / `logic.ts`：auth DTO、路径常量、错误分类。
- `catalog.css`：复用 `.surface` / 按钮类，新增连接条与状态点；守住 20 KB 复查线，超出时按计划修订预算并记录理由。
- 旧商城（`/auth/mode` 404）→ `unsupported`，隐藏连接 UI，安装照旧匿名；旧 core（`SecretService.Put` 缺失）→ `host_api_unsupported`，提示升级 SForum。

### 5.4 Schema / OpenAPI / 构建

- 新增 `schemas/auth-status.response.json`、`auth-start.response.json`、`auth-poll.request.json`、`auth-poll.response.json`、`auth-disconnect.response.json`；`install-url.response.json` 的错误变体已允许任意 code，无需改结构。
- `openapi/routes.yaml` 新增四条路径；`sforum.extension.json` 的 `openapi` digest 由 `build.sh` 的 `sync-digests.mjs` 更新。
- 运行 `bash plugin/scripts/build.sh`，提交摘要变化；`manifest:check` / `capabilities:check` 保持绿。

### 5.5 测试

- Go：fake 商城 HTTP + fake Host secret；start/poll/status/disconnect；PKCE；401 映射；secret 写失败；令牌不出现在日志；settings 缓存失效。
- 前端：`auth.test.ts` 覆盖状态机、轮询、超时、取消、断开、旧商城/旧宿主、错误文案；`catalog.test.ts` 覆盖连接条与安装按钮。
- 构建：`build.sh`、`bun test`、`go vet`/`go test`。

## 6. Core（SForum）

### 6.1 API

在 `contracts/proto/sforum/host/v2/resources.proto` 给 `SecretService` 增加：

```proto
rpc Put(SecretPutRequest) returns (SecretPutResponse);
rpc Clear(SecretClearRequest) returns (SecretClearResponse);
```

- `SecretPutRequest { context, string secret_id, bytes value, string media_type }`
- `SecretClearRequest { context, string secret_id }`
- 响应 `{context, error, bool secret_set, int64 version}`
- 约束：`secret_id` 必须是清单里 `type: "secret"` 的设置键；不接受 `sforum.secret://` 前缀；value ≤ 64 KiB（SecretStore 上限）。
- 重新生成 `apps/api/sdk/plugin/v2/gen/sforum/host/v2/*`；SDK `Host.Secrets` 自动获得 `Put`/`Clear`。

### 6.2 Handler

- `apps/api/app/Support/HostAPI/platform_resources_protocol_v2.go`：`ProtocolV2SecretServiceServer` 增加 `settings *settingslifecycle.Service`；`Put/Clear` 从 broker-attested identity 取 extension id，要求 authority 含 `settings.own`，校验 `settings.HasSecretField(extID, key)`。
- 写入走 `SettingsLifecycle.Put`：
  - set：`Put(ctx, extID, "extension:"+extID, map[string]string{key: token}, true)`；
  - clear：`Put(ctx, extID, "extension:"+extID, map[string]string{key: ""}, false)`。
- `SettingsLifecycle` 负责写 SecretStore、在设置文档里存 `sforum.secret://` 引用、CAS 保存；`RuntimeValues` 继续给插件解密读取。
- CAS 冲突返回 `host.settings_conflict`，插件重试一次；审计只记 key/version，不记 value。
- 接线：`apps/api/bootstrap/host_platform_services.go` 把 `settingsSvc` 传给 `NewProtocolV2SecretServiceServer`。
- 设置页无需改：`secret` 字段已有 `secretSet` 掩码；插件写入后页面显示「已配置」。

### 6.3 边界：core 应该开放什么、不开放什么

**开放（本轮）**：`SecretService.Put/Clear`。这是 `settings.own` 描述里「读写自身设置」缺的写半边；通用、可审计、只限声明字段，不引入商城概念。

**后续按需开放（写进 blueprint，不在 v1）**：

1. **Tier 1 `bridge.openExternal` + 清单 `externalOrigins`**：宿主代开外部链接、白名单、审计；解决弹窗拦截与任意导航。当前 `window.open` 已够用，等第二个消费者。
2. **Tier 2 actor 上下文 + 实例断言/JWKS**：`RouteRequest.Context.actor` + 实例密钥 + `/.well-known/sforum-instance.json`，让外部服务信任「这台论坛的哪个用户」；可实现免二次登录与按管理员归属。跨仓大改，v1 不做。
3. **Tier 3 secret 轮换/租约**：把 SecretStore 的 `Rotate`/租约暴露给插件；等后台任务需要长期凭据时再开。

**不开放**：商城专用登录 API、商城 OAuth 客户端注册、宿主代管商城令牌、`extensions.install` 命令/意图表（已被 `10c2b21e8` 否决）。

### 6.4 测试与文档

- `platform_resources_protocol_v2_test.go`：声明 secret 可写；非 secret/未知键按错误返回；缺 `settings.own` 按错误返回；clear；CAS 冲突；设置页 `secretSet`；`settings.own` 读回明文；重启后仍在。
- `SettingsLifecycle` 测试：partial Put 保留其他 secret；clear 只清目标。
- `docs/extensions/host-api-v2.md`：`SecretService.Put/Clear` 契约、限制、审计。
- `docs/extensions/authoring-guide.md`：secret 设置可由后端写入。
- `knowledge/decisions/2026-10-27-plugin-own-secret-write.md`：为什么补写半边、为什么不开放任意 secret、为什么不做商城专用 hook。

## 7. 安全与威胁模型

### 7.1 令牌

- 格式 `sfo_` + 43 字符 base64url；库存 SHA-256；scope `download:issue`；30 天；`revoked_at`；账号停用即失效。
- 落点：宿主 `SecretStore` 加密，设置文档只存引用；设置页只显示 `secretSet`。
- 传输：插件后端 → 商城 `Authorization: Bearer`，TLS；不经过浏览器，不进 URL。

### 7.2 PKCE / 一次性 / CSRF

- S256；verifier 43–128；request id 不可猜；批准后一次性兑换；`status` 条件更新；事务内 consume + token insert。
- 授权页 POST 同源 + SameSite=Lax；`Cache-Control: no-store`。
- 轮询最小间隔 2 秒；超限 `slow_down`。

### 7.3 钓鱼与确认

- 授权页显示商城账号、issuer、请求来源、短码；文案要求「只在你刚点过『连接商城』时允许」。
- 攻击者可以发起请求并诱导用户批准（设备授权模式的固有风险）；PKCE 保证只有发起方兑换，但批准后的令牌归发起方。文案与短码是唯一缓解；管理页不自动批准。

### 7.4 权限收紧

- catalog/settings 页与四条路由统一 `extension.plugin.manage`；`extension.view` 用户看不到安装页，同样调不到 auth/install 路由。
- 这是对「任何能进该管理页的论坛账号」的落地：能进 = 持有 `extension.plugin.manage`。
- 如果后续希望 viewer 也能浏览目录，需要宿主 bridge 暴露当前用户权限，另开计划。

### 7.5 明文禁令

- 令牌、verifier、签名 URL 不进日志、审计 details、错误响应、设置页回显。
- 插件 `failureResponse` 只写路由 id/错误码/短原因；商城 `recordAudit` 只写账号与产品维度。
- 测试断言：日志、审计、设置 API 响应中不出现 `sfo_` 或 verifier。

### 7.6 签名 URL 的边界

- 签发点验账号；签名 URL 30 分钟内仍是 bearer。文档只承诺「登录后才能拿到链接」，链接本身仍是 bearer。
- `downloadMode=redirect` 不变；302 一旦发出就收不回的既有取舍继续有效。

### 7.7 共享身份代价

- 令牌是论坛级；所有管理员共享。审计记授权账号，不记操作者。
- 断开/重新连接可以换账号；商城后台可撤销账号全部令牌（P1）。
- 要按管理员归属，走 Tier 2；不在 v1 承诺。

## 8. 上线与兼容

### 8.1 顺序

1. **Core**：`SecretService.Put/Clear` + 测试 + 文档 → SForum 发版（版本号在 PR 落地时确定）。
2. **商城**：迁移 + auth API + 授权页 + 强制 + 设置 + 契约；以 `download_auth_mode=anonymous` 部署。
3. **插件**：auth 流程 + secret 字段 + 路由收紧 + `sforumVersion` 提到新 core；发版。
4. **运维**：升级 core → 安装新插件 → 后台切 `account_required` → 验证安装与前台下载。
5. **回滚**：切回 `anonymous`；旧插件恢复；已发令牌保留到过期或手动撤销。

### 8.2 兼容矩阵

| 插件 | 商城 | Core | 行为 |
| --- | --- | --- | --- |
| 旧 | 新 / anonymous | 任意 | 与今天一致 |
| 旧 | 新 / required | 任意 | 401，页面「商城暂时不可用」；运维需先升级插件 |
| 新 | 旧 | 任意 | `/auth/mode` 404 → 隐藏连接 UI；安装匿名 |
| 新 | 新 / anonymous | 新 | 连接 UI 隐藏；安装匿名 |
| 新 | 新 / required | 新 | 完整连接 + 令牌 + 安装 |
| 新 | 新 | 旧 | `sforumVersion` 拦下安装；已装实例写 secret 失败 → `host_api_unsupported` |

### 8.3 配置

- `STORE_DOWNLOAD_AUTH_MODE=anonymous|account_required`（env 种子）；后台「系统设置 → 下载分发」覆盖。
- 令牌 TTL 常量 30 天；后续可做成设置。
- 新增限流 env：`STORE_RATELIMIT_INSTALL_AUTH_START`、`..._POLL`、`..._TOKEN`、`STORE_RATELIMIT_DOWNLOAD_ACCOUNT`。

### 8.4 运维提示

- 切 required 前先确认所有论坛的插件版本；商城后台给警告，但不做跨站探测。
- 商城 `publicUrl` 必须与插件配置的商城地址同源；否则授权页 origin 校验失败，页面提示检查 `STORE_PUBLIC_URL`。
- 授权页依赖论坛 OAuth2 会话；论坛未登录时先走论坛登录。

## 9. 验收

### 9.1 测试矩阵

- 商城：`bun test`（unit + PG 集成）、`bun run typecheck`、`bun run contract:generate` 无 diff、OpenAPI 校验。
- 插件：`bun test plugin/plugins/sforum.store/frontend/admin/src`、`go vet ./...`、`go test ./...`、`bash plugin/scripts/build.sh`、`bun run manifest:check`、`bun run capabilities:check`。
- Core：`go test ./...`（HostAPI、SettingsLifecycle、Extensions）、proto 生成无 diff、`go vet`。
- 端到端：`bun run dev`（supervisor，web + worker）起本地 dev 论坛 + 商城；停止用 `bun run dev:stop`；同一 checkout 不并行起第二个 dev（`lockDistDir` 锁）。连接 → 批准 → 安装 → 重启宿主 → 再安装 → 断开 → 再连接；切 `anonymous` 复测旧插件。

### 9.2 手工验收清单

- [ ] `account_required`：匿名 `download-urls` 401；有效令牌 200；宿主真实安装成功。
- [ ] 插件页连接一次；重启宿主后安装不再要求登录。
- [ ] 断开后安装重新要求连接；令牌撤销后 401。
- [ ] 商城前台未登录点下载 → 登录 → 文件开始下载。
- [ ] 令牌在设置页只显示「已配置」；DB 中只有 `sforum.secret://` 引用与密文。
- [ ] 日志、审计、API 响应无 `sfo_`/verifier/签名 URL。
- [ ] 旧插件 + anonymous 正常；新插件 + 旧商城隐藏连接 UI；新插件 + 旧 core 拦下安装。
- [ ] 限流、PKCE 不匹配、一次性兑换、CSRF 同源、过期请求各有 denied 用例。

### 9.3 截图

- 插件连接条（未连接 / 等待 / 已连接）1633×810 与 390×844。
- 商城授权页（待批准 / 已允许）两档。
- 商城前台「下载（需登录）」两档。

## 10. 执行顺序与工作拆分（单 agent）

### 10.1 执行方式

- 单 agent 顺序执行；不调用协作角色、不建共享任务、不把工作转给别的 agent。
- 每个阶段以「验收命令 + 证据」为出口；上一阶段没有全绿，不进入下一阶段。
- 阶段之间保持工作区可回滚：每阶段结束留一次提交或完整 diff，下一阶段从干净状态开始。
- 需要等待外部依赖（core 发版、CI pin）时原地等待/重试，不另开 agent。

### 10.2 阶段与出口

| 阶段 | 内容 | 主要文件 | 出口命令/证据 |
| --- | --- | --- | --- |
| P0 | 准备：读契约/宿主 API/现有测试；确认 core 版本号与 CI ref；建分支 | `contracts/store-api.yaml`、SForum checkout、`knowledge/plans/...` | 基线 `bun run test`、`bun run typecheck`、相关 `go test` 记录 |
| P1 | Core `SecretService.Put/Clear` | SForum proto/HostAPI/SettingsLifecycle/bootstrap/gen/docs | `buf generate` 无 diff；`go test ./app/Support/HostAPI/... ./app/Support/SettingsLifecycle/...` 绿 |
| P2 | 商城 auth 数据模型/API/授权页 server | `service/src/db`、`drizzle`、`lib/install-auth`、`api/v1/auth`、`api/connect`、`(auth)/connect` | `bun run db:migrate`；`bun test`（install-auth + PG 集成）；401 矩阵 |
| P3 | 商城强制/设置/契约 | `download-urls`、products download、settings、ratelimit、`contracts/store-api.yaml`、`api-types.ts`、health、admin settings | `bun run contract:generate` 无 diff；`bun run typecheck`；匿名 401/令牌 200；浏览器 302 |
| P4 | 插件 Go 后端 auth/secret | `plugin/.../backend/**`、`schemas/auth*`、`openapi/routes.yaml`、`sforum.extension.json`、`manifest/settings.json` | `go vet ./...`、`go test ./...`；401 映射；令牌不进日志 |
| P5 | 插件页连接 UI | `plugin/.../frontend/admin/src/**`、`dist/**` | `bun test plugin/.../frontend/admin/src`；CSS 预算；两档截图 |
| P6 | 集成/构建/摘要 | 包内文件冻结、`build.sh`、`dist`、manifest digests | `bash plugin/scripts/build.sh`；`bun run manifest:check`；`bun run capabilities:check` |
| P7 | E2E/文档/回滚 | `service/test/**`、`docs/**`、`knowledge/sessions/**` | `bun run test`、`bun run typecheck`；E2E；截图；回滚演练 |

### 10.3 阶段细节

**P0 准备**

- 读 `AGENTS.md`、`knowledge/index.md`、本计划、`contracts/store-api.yaml`、SForum 的 `contracts/proto/sforum/host/v2/resources.proto`、`apps/api/app/Support/SettingsLifecycle/service.go`、`apps/api/app/Support/HostAPI/platform_resources_protocol_v2.go`。
- 确认 core 版本号（第一个包含 `SecretService.Put` 的版本）与 `plugin/ci.yml` 的 SForum checkout ref；两者同批移动。
- 建分支：商城仓一个分支；SForum 仓一个 worktree/分支。记录基线测试结果。

**P1 Core**

- 改 proto，`buf generate`；实现 `Put/Clear` handler，走 `SettingsLifecycle.Put`；加 `HasSecretField`；接线 `settingsSvc`。
- 测试：声明 secret 可写；非 secret/未知键按错误返回；缺 `settings.own` 按错误返回；clear；CAS 冲突；设置页 `secretSet`；`settings.own` 读回明文；重启后仍在。
- 文档：`docs/extensions/host-api-v2.md`、`docs/extensions/authoring-guide.md`、`knowledge/decisions/2026-10-27-plugin-own-secret-write.md`。
- 出口：相关 `go test` 绿；proto 生成无 diff；core PR 可评审。

**P2 商城 auth**

- 迁移 `0015_install_auth.sql`：`install_auth_requests`、`account_tokens`、`store_settings.download_auth_mode`。
- `service/src/lib/install-auth/`：请求状态机、PKCE、令牌哈希/过期/撤销、mode 解析。
- 路由：`/api/v1/auth/{mode,requests,requests/{id},requests/{id}/token,me,revoke}`；授权页 `/connect/{id}` + `/api/connect/{id}/decision`。
- 测试：创建 → 批准 → 轮询 → 兑换 → 签发；匿名 401；过期/撤销 401；匿名模式 200；CSRF/同源；一次性兑换。
- 出口：`bun run db:migrate`、`bun test`（相关文件 + PG 集成）绿。

**P3 商城强制/设置/契约**

- `download-urls` 条件 Bearer；浏览器下载路由条件会话；`RuntimeConfig.downloadAuthMode`；后台设置 + 警告 + 审计；`/api/health`。
- 限流通道：`install-auth-start/poll/token`、`download-account`；env/default/后台面板。
- 契约：`bearerAuth`、六个 auth 端点、401；`contract:generate`。
- 前台：产品页「下载（需登录）」。
- 出口：`bun run contract:generate` 无 diff；`bun run typecheck`；匿名 401/令牌 200；浏览器 302；审计行。

**P4 插件 Go 后端**

- `backend/auth.go`：PKCE、商城 auth 客户端、status/start/poll/disconnect、secret 读写、401 清理。
- `settings.go`：secret 字段；`handlers.go`：install-url Bearer + 401 映射（当前 4xx 一律 404 `asset_not_found`，要改）；`upstream.go`：Authorization + auth 请求。
- 清单：`permissions` 加 `extension.plugin.manage`；catalog 页 `permission`；四条现有路由 + 四条新路由 `core.guard.permission`；`sforumVersion` 提到新 core；`manifest/settings.json` secret 字段。
- Schema/OpenAPI：`schemas/auth-*`、`openapi/routes.yaml`。
- 出口：`go vet ./...`、`go test ./...`；401 映射；令牌不进日志；schema 校验。

**P5 插件页**

- `auth.ts`：状态机、2 秒轮询、超时/取消、断开、错误映射；`window.open('about:blank')` + `opener=null`。
- `catalog.ts`：连接条、安装按钮状态；`copy.ts` zh-CN/en-US；`types.ts`/`logic.ts`；`catalog.css`。
- 旧商城/旧 core 降级；`unsupported`/`host_api_unsupported`。
- 出口：`bun test plugin/.../frontend/admin/src`；CSS 预算；两档截图。

**P6 集成**

- 冻结包内文件；重建 dist；跑 `build.sh`；提交摘要。
- `bash plugin/scripts/build.sh`；`bun run manifest:check`；`bun run capabilities:check`。
- 出口：三闸全绿；摘要变化已提交。

**P7 E2E/文档/回滚**

- `bun run dev` 起 web + worker；`bun run dev:stop` 停；连接 → 批准 → 安装 → 重启 → 再安装 → 断开 → 再连接；切 `anonymous` 复测旧插件。
- 文档：`docs/deployment.md`、`docs/plugin.md`、`docs/developer.md`；`knowledge/sessions/2026-10-27-download-auth-gate.md`。
- 截图：1633×810 / 390×844。
- 出口：全量测试、typecheck、E2E、截图、回滚演练记录。

### 10.4 阶段顺序与并行

- 顺序：P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7。
- P1 完成前不动 P2；P3 完成前不动 P4（插件后端依赖商城 API 形状）；P5 依赖 P4 的 DTO；P6 依赖 P5 的 dist。
- 外部依赖：core 发版是 P4 的 `sforumVersion` 与 CI ref 的前提；core 发版前 P1 只能在 SForum 仓内测试。

### 10.5 工作量口径

- 单 agent 顺序执行，按阶段出口推进；不按「人天」排，按「阶段 + 验收命令」排。
- 最长的阶段是 P1（core API）与 P2/P3（商城 auth + 强制）；P4/P5 在 API 形状稳定后较快。
- 每个阶段结束留一次提交/完整 diff，便于回滚。

## 11. 假设与待定

1. **令牌 TTL 30 天**（常量）；如果希望更短/更长，在实现前改。
2. **`download_auth_mode` 默认 `anonymous`**；新部署也默认匿名，由运维显式切换。
3. **商城单 issuer**；授权页复用现有 OAuth2 登录。
4. **catalog 页收紧到 `extension.plugin.manage`**；如果保留 `extension.view` 可见，需要宿主 bridge 暴露当前用户权限，另开计划。
5. **商城后台撤销安装令牌**为 P1；v1 至少支持插件「断开连接」。
6. **Core 版本号**在 `SecretService.Put` PR 落地时确定；插件的 `sforumVersion` 与 CI checkout ref 同批移动。
7. **前端 CSS 20 KB 复查线**；连接 UI 预计 +1–2 KB，超出时修订预算并记录。

## 12. 放弃的方案

- **页面持有 7 天令牌**：零 core 改动、按管理员归属，但用户选择后端长期持有；保留为回退路径。
- **SSO / 实例断言**：免二次登录，但需要 actor 上下文 + 实例密钥 + JWKS + 信任引导，跨两仓，v1 不做。
- **目录登录墙**：用户选择只在签发时强制；目录继续公开。
- **每次安装一次性令牌**：最干净，但每次安装都要切标签授权，成本压在动作点。
- **插件后端明文存令牌**：长期 bearer 明文落库，备份/只读库都会泄。
- **页面直调宿主内部 settings API**：绕过 bridge 边界、依赖内部路径与 CSRF 细节，脆弱。
- **商城专用 core hook / 宿主代管商城令牌**：违反 out-of-tree，且把 core 绑死在一个产品上。

## 13. 执行入口（新对话）

1. 读 `AGENTS.md` → `knowledge/index.md` → 本文件。
2. 单 agent 顺序执行：不调用协作角色、不建共享任务、不把工作转给别的 agent。
3. 按 §10 的阶段顺序执行；先做 P0/P1，P1 完成后再动 P2。
4. 每个阶段结束给出：改了什么、验证命令与结果、下一步；P1/P3/P6/P7 四个节点向操作者汇报。
5. core 发版与 `download_auth_mode` 切 `required` 由操作者拍板；插件 `sforumVersion` 与 CI checkout ref 同批移动。
6. 硬约束：令牌/verifier/签名 URL 不进日志、审计、响应；后台截图 1633×810 与 390×844；本地起服务用 `bun run dev`，停用 `bun run dev:stop`。
