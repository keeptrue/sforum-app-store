# 应用商城 · 服务端与插件（`sforum-app-store`）

Status: **draft（讨论中，未批准实施）**
Started: 2026-10-24

- **权威副本**：本文件。SForum 仓的 `knowledge/plans/2026-10-24-app-store-service.md` 按流程
  保留原样，不再更新；定稿后由人工决定是否改成指针。
- **来源基线**：SForum HEAD `cf2c6e1cfd82fc1f0a186a8140dbe6e26740c1fc`（2026-10-24）。
- **只读伴生计划**：SForum `knowledge/plans/2026-10-24-app-store-core-install-primitive.md`
  §6.2（安装命令契约）。本仓不复制、不改写它；契约变更以该计划为准。
- **决策记录**（批准实施时创建）：`decisions/2026-10-24-app-store-out-of-tree.md`、
  `decisions/2026-10-24-app-store-identity-and-distribution.md`。
- **变更规则**：状态停在 `draft`，直到人工明确「批准」。每轮讨论只改本文件与
  `knowledge/plans/README.md` 对应行。

## 1. 产品形态

应用商城 = **一个独立服务端 + 一个 SForum 插件**，放在同一个仓库，作为两个独立产物发布：

- `service/`：Next.js + Bun + PostgreSQL。公开目录 API、公开前台、开发者门户、审核后台、
  GitHub 同步、签名下载代理。
- `plugin/sforum.store`：SForum 扩展（Go 后端 + 预构建 Vue 管理页）。只负责站内浏览、解析与
  安装交接。
- `contracts/store-api.yaml`：两者共享的 OpenAPI 契约；生成 TS 类型与 Go client，避免跨产物
  漂移。

为什么服务端不是 SForum 插件：它服务多个论坛、拥有独立生命周期与故障域、要处理不可信开发者
输入与 GitHub 出站流量；把它塞进某一个论坛实例会让目录可用性、权限面和发布节奏全部被单站点
绑死。

## 2. 已确认约束

1. **登录**：SForum 的 OAuth2 提供方是独立插件 `sforum-oauth2-provider`，端点形如
   `/api/oauth/authorize|token|userinfo|revoke|introspect|csrf`；授权码 + PKCE、refresh 轮换、
   scope 三层约束。
2. **CSRF**：它的所有插件路由都在宿主 CSRF 中间件后。服务端换 token / refresh / revoke 必须：
   先 `GET /api/oauth/csrf` 拿 `csrf_` cookie → 再带 `X-Csrf-Token` + `Origin: <forum>` 发 POST。
3. **userinfo**：只认 `access_token` 查询参数（插件路由拿不到 `Authorization`）。
4. **无动态客户端注册**：`client_id/secret` 只能在论坛后台手工建；商城对身份提供方必须
   **配置驱动**。
5. **GitHub**：全量使用 GitHub App（不设验证文件）；私有 release 资产只能通过 installation
   token 读取。
6. **安装**：SForum 侧提供 `sforum.extensions.install.{plugin|theme}@1` +
   `sforum.extensions.install.status@1`（见伴生计划 §6.2）。商城插件是唯一调用者，且必须人类
   管理员当场触发。
7. **core 下载器**：只接受 public HTTPS，50 MiB / 90 s（`ExtensionDownload.DefaultMaxBytes` /
   `DefaultTimeout`），支持 `sha256` 钉住；商城下载地址必须公网可达。

### 2.1 本轮核实过的事实（取代任何推测）

8. **一个 ZIP 只含一个扩展**：`ReadArchive` 只返回单个 `Manifest`
   （SForum `apps/api/app/Support/ExtensionPackage/archive_reader.go:24`）；manifest v3 的 `id`
   是单值且 `additionalProperties: false`。所以「monorepo 多扩展」= **一个 tag 挂 N 个 ZIP**，
   不存在「一包装 N 个扩展」。
9. **`sforumVersion` 是 semver 约束**（Masterminds 语义，SForum
   `.../ExtensionManifest/v3_validate.go:31`），但 vendored schema 只把它当 `nonEmpty`
   （`manifest-v3.schema.json:48`）。所以「schema 校验通过」≠「core 接受」，也不能按版本等值
   过滤兼容性。
10. **secret 轮换是单哈希覆盖**（`sforum-oauth2-provider/.../clients.go:193`），无双 secret
    宽限；但刷新令牌绑 `client_id`、客户端认证发生在 grant 分派之前（`token.go:24-27`），所以
    轮换不会把已登录用户踢下线。
11. **客户端凭据只能走请求体**（`token.go:14-15`：Host 以 filtered authority 交付，剥离
    `Cookie` 与 `Authorization`）。任何走 Basic 认证的标准 OAuth 库都会失败。
12. **未验证**：宿主是否向插件暴露自身 SForum 版本号。已按
    `buildVersion|BuildVersion|site.version|platformVersion` 搜索 `apps/api/app`，只找到
    SystemUpdates 的构建信息与测试引用。若确无读取面，目录的 `?sforum=` 兼容性过滤需要换形状
    （见 §10 Q4）。

## 3. 关键决策

- **D1 独立服务端**：多论坛、独立发布、独立故障域、不可信输入隔离。
- **D2 一个仓库两个产物**：共享 OpenAPI 与 CI，但镜像与插件 ZIP 分开发布。
- **D3 全量 GitHub App**：安装 App 即证明仓库归属，同时解锁私有 release；不存 PAT，不用
  OAuth App 的 `repo` 大权限。
- **D4 所有下载走商城签名短链代理**：统一一条信任链、隐藏上游地址、支持私有仓库与撤销；代价
  是带宽，CDN/公开直链留到后续。
- **D5 自动检测，不靠文件名**：ZIP 内 `sforum.extension.json` + `backend.entry` 的
  `debug/buildinfo` + 流式 SHA-256；文件名/头部只做兜底并记录 `detection_source`。
- **D6 图片上传到商城**：PNG/JPEG/WebP、禁 SVG、魔数与尺寸校验、内容寻址；不引入 `sharp`。
- **D7 登录只走 SForum OAuth2**：商城不注册、不存密码；账号唯一键 `(issuer, sub)`；论坛 token
  加密落库、refresh 轮换。
- **D8 审核**：首个产品/首个 release 人工，后续 release 自动同步；改名、换仓、新增高危能力重新
  进审。
- **D9 目录不签名（v1）**：HTTPS + 每资产 SHA-256 + 签名下载短链已覆盖；离线镜像/多镜像再引入
  签名快照。
- **D10 v1 不做支付/授权**：数据模型预留 `entitlements/licenses`，但不接支付。

## 4. 仓库布局

已建（2026-10-24）：

```text
sforum-app-store/
  AGENTS.md                    # 仓库约定（先读）
  README.md
  knowledge/                   # 项目记忆：index / glossary / plans / decisions / sessions
  contracts/                   # store-api.yaml（S0 落地）
  service/                     # Next.js + Bun + Drizzle
  plugin/                      # SForum 外部扩展源根
  docs/                        # 部署、开发者接入、GitHub App 注册
```

目标布局（S0 之后逐项落地）：

```text
service/
  src/app/…                    # 公开前台 / dashboard / moderation
  src/app/api/v1/…             # 公开 API + 插件 API
  src/lib/…                    # oauth client, github app, detection, storage
  src/worker.ts                # pg-boss worker（release 同步 / 资产检测）
  drizzle/                     # schema + migrations
plugin/plugins/sforum.store/
  backend/                     # Go module（replace 到 SForum 检出）
  frontend/admin/               # Vue 3 + Vite，预构建 dist
  manifest/                    # admin / settings / langs
  schemas/                     # 命令与组件 schema
  openapi/                     # 插件路由契约
  sforum.extension.json
contracts/store-api.yaml
```

- 插件后端 `go.mod` 沿用 `sforum-oauth2-provider` 的做法：`require
  github.com/zhuchunshu/sforum/apps/api v0.0.0` + 本地 `replace`，CI 用 `go mod edit -replace`
  指向检出目录。
- 根 `package.json` 使用 Bun workspace：`service` + `plugin/plugins/sforum.store/frontend/admin`。

## 5. 服务端

### 5.1 栈与运行时

- Next.js（App Router）+ TypeScript + Tailwind；Bun 作为包管理器与运行时。
- 脚本：`dev: bun --bun next dev`、`build: bun --bun next build`、`start: bun --bun next start`、
  `worker: bun run src/worker.ts`。
- **Bun 运行时闸门**：CI 必须跑一次 `bun --bun next build` + 启动冒烟（`/api/health` + 一页
  SSR）。若原生依赖失败，只允许 `next start` 回退 Node，其余保持 Bun——由 CI 证据决定。
- PostgreSQL 16 + Drizzle ORM + drizzle-kit；`pg-boss` 作为 Postgres 队列（独立 worker 进程，
  同镜像）。
- 图片：`file-type` 验魔数 + `image-size` 读尺寸；内容寻址存储（本地卷，预留 S3 适配器）。

### 5.2 身份与会话

> **待定**：多 issuer 的拓扑与 client 注册/轮换方式见 §10 **Q1**（当前 §5.2 与 §5.10 假设
> 配置驱动多 issuer，而旧稿 §8 把它列为未决）。

- 配置：`STORE_OAUTH_ISSUERS`（每项含 `issuer/client_id/client_secret/authorize/token/userinfo/
  revoke/csrf`）。官方实例绑官方论坛；自部署绑自己的论坛。
- 登录：
  1. `GET /api/auth/sforum/start?issuer=…` 生成 `state` + PKCE，写短时签名 Cookie。
  2. 跳 `${issuer}/api/oauth/authorize?client_id&redirect_uri&response_type=code&scope=profile
     avatar&state&code_challenge&code_challenge_method=S256`。
  3. 回调 `GET /api/auth/sforum/callback?code&state`：验 state → CSRF 握手 +
     `POST /api/oauth/token` → `userinfo?access_token=`。
  4. 按 `(issuer, sub)` upsert 账号；建商城会话；论坛 token 用 AES-256-GCM 加密落库。
- 刷新：`grant_type=refresh_token`，每次轮换并写回；失败标 `reauth_required`，页面提示重登，
  不静默登出开发者。
- 登出：best-effort `POST /api/oauth/revoke`（同样先 CSRF 握手）+ 删除会话。
- 商城会话：`__Host-store_session`（HttpOnly/Secure/SameSite=Lax），PG sessions，支持「撤销其它
  设备」。
- 角色：`store_roles(account_id, admin|moderator)`，由 `STORE_BOOTSTRAP_ADMINS`（`issuer#sub`）
  播种；**不信任论坛用户组**。
- scope：默认 `profile avatar`；`email` 仅在开发者主动选择公开联系邮箱时申请，并在 UI 说明
  用途。

### 5.3 数据模型

> **待定**：产品生命周与上游连通性是否拆成两条轴见 §10 **Q2**；release/version 是否分两层见
> §10 **Q3**；tag 与 manifest 版本冲突规则见 §10 **Q4**。

- `accounts`：`(issuer, sub)` 唯一；username/display_name/avatar_url/email/email_verified。
- `sessions`、`oauth_token_sets`（加密 token、过期、scope）。
- `oauth_issuers`：配置来源 + 最近校验时间。
- `products`：`extension_id` 全局唯一、`owner_account_id`、`kind(plugin|theme)`、
  `status(draft|pending|published|yanked)`、`repo_id`、`slug`、分类/标签、`default_locale`。
- `product_translations`：`(product_id, locale)` → name/summary/description；回退默认语言。
- `assets`：sha256/mime/width/height/bytes/storage_key；`product_screenshots` 排序。
- `releases`：`product_id`、`version`（取 manifest，不用 tag）、`tag`、`channel(stable|beta)`、
  `published_at`、`notes_md`、`yanked`。
- `release_assets`：`release_id`、`os`、`arch`、`filename`、`size`、`sha256`、
  `upstream_asset_id`、`detection_source`、manifest 元数据
  （`extension_id/version/type/sforum_version/capabilities`）。
- `github_installations`、`github_repos`（installation_id/repo_id/full_name/private/archived/
  default_branch）。
- `sync_state`：ETag、last_checked、last_error、next_check_at。
- `moderation_events`、`audit_log`。
- v2 预留：`entitlements`、`licenses`、`download_nonces`。

### 5.4 GitHub App

> **待定**：官方/自部署 App 的边界、最小权限与卸载/暂停后的产品状态见 §10 **Q2**。

- 注册（一次性）：`Contents: read` + `Metadata: read`；订阅 `release`、`installation`、
  `installation_repositories`（建议补 `repository`）；回调 `${store}/api/github/setup`；webhook
  `${store}/api/github/webhook`。
- 安装：`GET /api/github/install/start` → `https://github.com/apps/<slug>/installations/new?state=…`
  → setup 回调存 `installation_id` → `GET /installation/repositories` 让开发者选仓库。
- 令牌：App 私钥签 10 分钟 JWT → `POST /app/installations/{id}/access_tokens` → 1 小时 token；
  缓存到过期前 60 s。
- Webhook：验 `X-Hub-Signature-256`；`release` 入队增量同步；`installation*` 更新可见性；卸载即
  标记产品不可下载，下载立即失效。
- 自部署矩阵：官方实例用官方 App；自部署必须注册自己的 App（部署文档给 10 分钟步骤），缺配置
  启动即失败。

### 5.5 同步与自动检测

- 对每个 release 的非源码 `.zip` 资产：
  1. 下载到临时文件（≤50 MiB、90 s），校验 ZIP。
  2. 读根目录（或单层子目录）`sforum.extension.json`，按仓内 vendored `manifest-v3.schema.json`
     校验；取 `id/version/type/sforumVersion/capabilities`。注意 schema 只保证 `sforumVersion`
     非空，真正的约束校验在 core（§2.1 事实 9）。
  3. 有 `backend.entry`：读该二进制，`debug/buildinfo` 取 `GOOS/GOARCH`（含
     `GOARM/GOAMD64`）；无 backend（主题）→ `any/any`。
  4. 流式计算 ZIP SHA-256；若 release 带 `checksums.txt`/`SHA256SUMS`，交叉校验，不一致即失败。
  5. **按 `extension_id` 分组**（一个 ZIP 只有一个扩展，见 §2.1 事实 8）：同一 tag 允许多个 ZIP
     对应多个扩展；**每组内** `version/type` 必须一致；组内同 `(os,arch)` 出现两个候选 →
     `needs_attention`，要求 `sforum-release.json` 覆盖，**不猜**。
  6. 兜底顺序：buildinfo → ELF/Mach-O 头 → 文件名约定；每次兜底写 `detection_source`，审核
     可见。
  7. 临时文件用后即删；不留包体、不写对象存储。
- 同步触发：webhook 即时 + 每小时兜底轮询（ETag）；产品页提供「手动刷新」，限流。

### 5.6 下载代理

> **待定**：token 的 TTL 与单次性见 §10 **Q5**。已知硬矛盾：token 5 分钟（本稿）< 安装意图
> 15 分钟（伴生计划 §6.8 第 7 条），且 core worker 有 3 次重试、无法重新签名。

- 目录/详情只返回 `downloadUrl`（签名 token：asset id / sha256 / exp）+ `sha256` + `size`，不
  暴露 GitHub 原始地址。
- `GET /api/v1/download/{token}`：验签 → 产品/release 未 yank → 用 installation token 流式转发。
- 响应头：`Content-Type: application/zip`、`Content-Length`、`Content-Disposition: attachment`、
  `nosniff`、`Cache-Control: private, no-store`。
- 公开仓库同样走代理（统一一条信任链）；带宽压力大时再加 `directPublic` 快路径，不改协议。

### 5.7 API（契约优先）

`contracts/store-api.yaml` → `openapi-typescript`（TS）+ `oapi-codegen`（Go client）。`/api/v1`：

- `GET /catalog?channel=&sforum=&os=&arch=&q=&category=&cursor=`（ETag）
- `GET /products/{slug}`
- `GET /products/{slug}/releases`
- `GET /products/{slug}/releases/{version}`
- `GET /products/{slug}/download/{os}/{arch}` → 302 到签名 URL
- `GET /health`

错误体 `{code, message, details}`；`Cache-Control: public, max-age=60,
stale-while-revalidate=300`；分页 cursor。

> 注意：`?sforum=` 的语义依赖 §2.1 事实 12（宿主版本读取面未验证），见 §10 Q4。

### 5.8 页面

- 公开：`/`（推荐/最新/最近更新）、`/products`（筛选/搜索）、`/products/[slug]`（图标、截图、
  介绍、版本历史、changelog、平台矩阵、仓库链接）、`/docs`（开发者接入）。
- 登录后：`/dashboard`（我的产品、连接仓库、发布、yank）、`/dashboard/products/[id]`。
- 审核：`/moderation`（首个产品/首个 release 人工；异常重新进审）、审计日志。
- i18n：UI `zh-CN` 默认 + `en-US`；产品文案走 `product_translations`。
- SEO：SSR + canonical + 每产品 OG 图。

### 5.9 安全

- 出站白名单：GitHub API 与对象存储。全量 App 之后不存在用户可控的抓取 URL，因此**不建**通用
  SSRF 抓取器（旧稿「SSRF 安全抓取」条目作废）。
- changelog 服务端消毒后输出；产品描述同样消毒。
- 上传：魔数 + 尺寸 + 禁 SVG + 随机文件名 + 长缓存。
- 登录/提交/下载限流；webhook 验签；会话轮换；审计。
- 依赖与 GitHub Actions 固定版本；私钥只从环境/密钥管理读取。
- 开发者只能管理自己 installation 下的仓库与产品；越权按 404 处理。

### 5.10 部署矩阵

| 场景 | 身份提供方 | GitHub App | 下载 |
| --- | --- | --- | --- |
| 官方商城 | 官方论坛 OAuth2 client | 官方 App（公共安装） | 商城签名代理 |
| 自部署商城 | 自己论坛的 OAuth2 client | 自己注册的 App | 商城签名代理 |
| 纯内网/离线（后续） | 自己论坛 | 自己 App 或本地镜像 | 本地镜像 + 签名快照 |

## 6. 商城插件 `sforum.store`

### 6.1 清单

- `id: sforum.store`、`type: plugin`、`manifestVersion: 3`
- `capabilities: [host.api, settings.own, net.outbound, extensions.read, extensions.install]`
- `database.grants: [host_commands]`（`commands[]` 是插件对外发布的命令，不用于调用宿主命令）
- `admin.pages: [{path:"/store", view:"component", menu:true, group:"应用商城",
  permission:"extension.view", component:{…}}]`
- 设置：`catalogBaseUrl`（默认官方）、`channel`、`locale`、`cacheTtl`、`allowPrerelease`；v2 预留
  `licenseKey`（secret）。
- 前端 Vue 3 + Vite + `@sforum/admin-sdk`/`@sforum/plugin-ui`，预构建到
  `frontend/admin/dist/*.mjs|*.css`。

> `allowPrerelease` 等设置项的默认值尚未逐项写死（BR 默认值友好原则要求有推荐默认 + 一键重置）。

### 6.2 后端路由（命名空间内）

- `GET /catalog`：带宿主 `os/arch`（`runtime.GOOS/GOARCH`）、channel、locale 取商城目录；合并
  `extensions.read` 的已装清单。
- `GET /product/:slug`：详情 + 版本 + 当前平台资产。
- `POST /install`：解析资产 → 调 `sforum.extensions.install.{plugin|theme}@1` → 返回 `intentId`。
- `GET /install/:intentId`：调 `sforum.extensions.install.status@1`。
- `GET /updates`：已装版本 vs 最新兼容版本。

### 6.3 页面与交互

> **待定**：完整状态机（含无权限、stale 缓存、worker 超时）见 §10 下一轮议题（原阻塞项 7）。

- 侧栏一级「应用商城」；插件/主题两个页签；搜索、分类、兼容性筛选、已装徽标。
- 详情：图标/截图/介绍/版本/changelog（纯文本或已消毒 HTML）/平台矩阵/仓库外链。
- 安装：按钮 → 后端 `POST /install` → 轮询状态（1s，最长 2 分钟）→ `staged` 后显示「已暂存，
  去完成信任/升级」→ `bridge.navigate('/extensions/plugins')`。
- 无安装权限（非 super_admin、无对应 manage）时隐藏按钮，后端仍校验；错误按 `errorCode` 映射
  成可读文案。
- 不做自动启用、不做后台静默安装。

### 6.4 缓存与降级

- 商城目录缓存在 Host `PluginFiles`（`kind=private`），带 ETag + `fetchedAt`；TTL 10 分钟，
  stale 兜底 24 小时并显式标注「数据更新于 X」。
- 商城不可达：展示缓存、禁用安装并提示；不伪造版本。

### 6.5 与 core 的安装交接

1. 插件后端拿到 `intentId` 后轮询状态。
2. `staged` → 页面显示结果（扩展 ID、版本、摘要）+ 跳转 core 插件/主题页。
3. 管理员在 core 完成 trust challenge 与启用；商城不代劳。
4. 如果目标是已启用插件的新版本：core 只暂存候选，页面文案必须写「去完成升级」，不能写
   「已更新」。

## 7. 阶段与验收

> **待定**：S1/S2/S4 的通过条件目前不可判定（见 §10 A9），批准前要逐条写成交付物。

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| S0 | 仓库骨架、OpenAPI 契约、CI（Bun 冒烟 + Go 插件构建） | 空壳可构建；契约生成通过 |
| S1 | OAuth2 登录（CSRF 握手、refresh 轮换、会话） | 真实论坛登录/刷新/撤销通过（待写细则） |
| S2 | GitHub App 安装 + 仓库选择 + release 同步 + 自动检测 | 公开/私有 fixture 各一条 release 被正确解析（待写细则） |
| S3 | 产品 CRUD + 图片上传 + 公开 API + 公开前台 | 产品页 SSR、筛选、分页、ETag |
| S4 | 开发者门户 + 审核后台 | 首个产品人工审核；后续 release 自动（待写细则） |
| S5 | 插件 MVP（目录/详情/安装/更新/缓存） | 浏览器 1633×810 + 390×844；端到端安装到暂存 |
| S6 | 加固与文档（yank、限流、审计、自部署矩阵） | 端到端演练 + 回滚演练 |

## 8. 风险与未决

**风险**

- **Bun + Next 生产运行时**：以 CI 冒烟为准；失败仅回退 `next start`。
- **GitHub App 全量**：公开仓库开发者也需安装；自部署需自建 App。文档必须写清失败提示。
- **OAuth provider 的 CSRF/cookie 约束**：集成测试需打到真实 provider 或高保真 fake（未选）。
- **清单 schema 漂移**：service vendored schema + CI 与 SForum tag 对比，漂移即失败；对比目标
  （tag / commit / main）未定。
- **扩展 ID 抢注**：`extension_id` 全局唯一 + App 安装即归属；但归属绑在 `(issuer, sub)`，issuer
  下线后没有回收路径（§10 A8）。
- **带宽**：全量代理是刻意选择；CDN/直链快路径留到后续。

**未决**：见 §10 台账（A1–A9 为已识别缺口，Q1–Q5 为本轮决策项，Q6–Q8 为下一轮）。

## 9. 假设

- 论坛已安装并启用 `sforum-oauth2-provider`，商城 client 已在论坛后台注册。
- 商城以 public HTTPS 暴露，能被论坛 API 访问。
- SForum 插件后端为 Go；非 Go 后端走头部/文件名兜底并标记检测来源。
- 首版不含支付/授权；数据模型预留。
- PostgreSQL 16+；不引入 Redis。

## 10. 讨论台账（2026-10-24 第一轮）

### 10.1 已识别缺口

| # | 位置 | 问题 | 后果 |
| --- | --- | --- | --- |
| A1 | §5.2 / §5.10 vs 旧稿 §8 | 多 issuer 同时写成「配置已支持」和「未决」 | 数据模型与 UI 都无法定稿 |
| A2 | §5.6 ↔ 伴生计划 §6.8 | 下载 token 5 分钟，安装意图 15 分钟 | worker 取到时 URL 可能已过期 |
| A3 | §5.3 / §5.6 | token 带 nonce，`download_nonces` 却排到 v2 | 现在只是「5 分钟内可重放」，不是单次 |
| A4 | 旧稿 §5.5 第 5 条 ↔ §8 | 「同 release 同 extension id」与 monorepo 互斥 | 一仓多扩展必被判 needs_attention；已按事实 8 改写 |
| A5 | §5.3 | 产品 status 与 release yanked、上游断开挤在一条 enum | yank 与 disconnected 抢字段，状态机会打架 |
| A6 | §5.3 | tag 冲突、同版本换摘要均无规则 | 宿主是 exact-artifact；同版本改字节会逼运维重做信任确认 |
| A7 | §5.7 + 事实 9 | `sforumVersion` 是约束不是版本号 | 按版本等值过滤会漏判兼容性 |
| A8 | §5.3 / D3 | 归属绑 `(issuer, sub)`，issuer 下线后无回收 | 商品变僵尸，抢注防线失效 |
| A9 | §7 | S1/S2/S4 验收没有可判定条件 | 阶段无法签字 |

### 10.2 本轮决策项（全部待定）

**Q1 身份拓扑**（含两个子项）

- A. 官方实例固定单 issuer（官方论坛）；自部署实例按 `STORE_OAUTH_ISSUERS` 支持 N 条，数据模型
  一律 `(issuer, sub)`。
- B. 官方也开多 issuer，但只走人工白名单（每个 issuer 单独登记 client）。
- C. 开放联邦：任何论坛都能当 issuer。
- **倾向 A**：B 每加一个 issuer 都是一次人工建 client + 白名单运维，还要解释「同一人两个账号、
  产品不合并」；C 把账号发放权交给任何能建站的人。
- Q1a client 注册/轮换：倾向 v1 只走 env，不做后台「连接论坛」向导；轮换 = rotate → 更新 env →
  滚动重启（不踢已登录用户，见事实 10）。
- Q1b issuer 下线：倾向 v1 就做 admin「转移所有权」，否则 ID 被僵尸商品长期占住。

**Q2 GitHub App 边界**

- App 数量：A. 一部署一 App（官方 App 只服务官方商城，自部署自建）；B. 共享 public App 多租户
  回调。**倾向 A**（B 会让官方成为所有自部署实例私有仓库的中间人）。
- 权限：`Contents: read` + `Metadata: read`，不要 `Administration`/`Actions`。
- 事件：`release` + `installation` + `installation_repositories` + **`repository`**（旧稿漏）。
- 状态：A. `status`（draft/pending/published/yanked）+ `upstream_state`
  （connected/degraded/disconnected + reason + checked_at）双轴；B. 单 enum。**倾向 A**。

**Q3 数据建模**

- A. 一仓一扩展，monorepo 审核阶段拒。
- B. 仓库级 release + 扩展级版本（`repo_releases` → `release_versions` → `release_assets`）。
- C. 产品=仓库，扩展=子实体。
- **倾向 B**：安装单位是单个扩展（事实 8），展示单位常是仓库，B 让两者解耦。代价是 `releases`
  语义从「产品版本」改成「仓库标签」。
- 一并要定：`extension_id` 跨仓库全局唯一，冲突由审核裁决。

**Q4 版本语义**

- 已倾向：版本以 manifest 为准；同产品新版本必须严格大于现有最高版本；**同版本不同 sha256
  硬拒**（`version_conflict`）；预发布 = `prerelease=true` 或 semver 带 `-` → `channel=beta`，
  默认不进目录；`draft` 显式忽略。
- 待你定：tag 与 manifest 不一致时 → A. 单扩展组进 `needs_attention`（倾向）；B. 以 manifest
  为准、tag 只做展示。

**Q5 下载 token**

- A. 长 TTL + 不单次 + 绑定 sha256：TTL 30 分钟，请求时校验「仍是当前发布版本且未 yank」，yank
  即 410。
- B. 短 TTL + 单次 + 改契约：URL 从 install 输入里拿掉，让 core 自己回源换签名 URL。
- **倾向 A**：B 要改伴生计划 §6.2 的输入形状，且让 core 认识商城，破坏「唯一契约」；A 的额外
  风险只是「提前拿到一个本来就公开可下载的 ZIP」。

### 10.3 下一轮议题（原阻塞项 6–8）

- 产品页信息架构：截图数量/尺寸、分类法、排序、搜索、中英双语字段粒度。
- 插件页 UX 状态机：列表/详情/安装/更新/错误，无权限与 stale 缓存的文案。
- 运维：Bun 回退 Node 的判定标准、自部署 GitHub App 的 10 分钟步骤、备份/迁移。

## 11. 批准前还缺什么

1. Q1–Q5 的人工裁决（本轮）。
2. §7 S1/S2/S4 的可判定验收细则。
3. §5.3 的最终 schema（依赖 Q2/Q3）。
4. 数据保留与账号删除口径（论坛 token、审计日志、上传图片）。
5. vendored manifest schema 的来源钉法（SForum tag vs commit vs main）。

**在以上完成前，本计划不进入 `ready`，不写产品代码。**
