# 应用商城 · 服务端与插件（`sforum-app-store`）

Status: **active（2026-10-24 批准，S0–S4 完成）**
Started: 2026-10-24

- **权威副本**：本文件。SForum 仓的 `knowledge/plans/2026-10-24-app-store-service.md` 按流程
  保留原样，不再更新；定稿后由人工决定是否改成指针。
- **来源基线**：SForum HEAD `cf2c6e1cfd82fc1f0a186a8140dbe6e26740c1fc`（2026-10-24）。
- **只读伴生计划**：SForum `knowledge/plans/2026-10-24-app-store-core-install-primitive.md`
  §6.2（安装命令契约）。本仓不复制、不改写它；契约变更以该计划为准。
- **决策记录**：`decisions/2026-10-24-app-store-out-of-tree.md`、
  `decisions/2026-10-24-app-store-identity-and-distribution.md`、
  `decisions/2026-10-24-ui-stack.md`。
- **变更规则**：已批准实施，按 §7 阶段推进；每阶段完成更新本文件与
  `knowledge/plans/README.md`。状态变更需人工确认。

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
12. **已核实：宿主当前没有向插件暴露应用版本**。`apps/api/version` 有
    `CoreCompatibilityVersion()`（`version.go:81-89`：`dev` → `1.0.0`，其余原样返回、**不校验
    semver**；2026-10-26 起 dev 改为从 git tag 派生，见 §10.2 Q6 指针），但它只被 migrator 与
    DB 兼容闸门使用；插件能拿到的 `host.api`
    `Ping.data.version` 是 **Host API 协议版本**（`app/Support/HostAPI/v1_test.go:99`），不是
    应用版本。唯一带 `HostSForumVersion` 的 `app/Support/Marketplace/**` 在 P0 整包删除。
    SForum 伴生计划 D9 明确「暂不做 `hostVersion`」。结论：商城要按约束过滤，必须先由 SForum
    暴露应用版本（见 §5.7、§10.2 Q6、§10.4）。
13. **`version` 是强 semver，且 core 不比较版本序**：`validateV3Manifest` 用
    `semver.StrictNewVersion(manifest.Version)`（SForum
    `apps/api/app/Support/ExtensionManifest/v3_validate.go:28`），不是只判非空；而
    `InstallOrUpgradeArchive` 只按 `manifest.ID` 是否存在判定 upgrade
    （`apps/api/app/Models/Extensions/lifecycle.go:94-98`），**不比较新旧版本**。所以「不许
    降级」只能是商城侧策略，不能指望 core 兜底。
14. **River 重试与意图状态机冲突（SForum 侧，待确认）**：伴生计划 §6.6 第 1 步「非 `pending`
    直接成功返回」与「网络错误交给 River 重试」自相矛盾 —— 首次失败后意图已置 `running`，重试
    进来会被第 1 步短路成成功，意图永久停在 `running`。另 `MaxAttempts: 3` 是共 3 次尝试
    （2 次重试），不是 3 次重试。本轮只登记，不改 SForum，见 §10.4。

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
- **D7 登录只走 SForum OAuth2**：商城不注册、不存密码；账号唯一键 `(issuer_key, sub)`；论坛
  token 加密落库、refresh 轮换。
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

**拓扑（Q1 已裁决）**：一个部署同一时刻只有一个 active issuer。官方实例 = 官方论坛；自部署
实例 = 自己论坛。`oauth_issuers` 可保留多条 retired 行作历史归属，登录只认 active。数据模型
仍按 `(issuer_key, sub)` 建键 —— `issuer_key` 是运营方指定的稳定标识（`official`、
`self`），**不是 URL**；硬不变量：永不复用、永不改名。换域名只改 `base_url`，账号与商品归属
不断。

- `oauth_issuers` 是真相表：`issuer_key`（唯一、不可变）、`display_name`、`base_url`、
  `client_id`、`client_secret_ciphertext` + `key_version`、`scopes`、`status(active|retired)`、
  `last_verified_at`、`last_error`。替换 issuer 是一次显式迁移（旧行转 retired、新行上线），
  事务外不允许出现零个 active issuer。
- 首条 issuer 由 `STORE_BOOTSTRAP_ISSUER`（base_url + client_id + secret）在首启时种入 ——
  没有它就没有人能登录去用后台向导。首启之后 env 只做种子，不再覆盖库内值；env 与库不一致
  只告警，不自动改写。**轮换 secret 后必须同步更新或移除 env 种子**，否则灾后重建会用旧
  secret 种入，表现为登录失败 —— 启动告警要直接写这句。
- 后台 `/admin/issuers`（「连接论坛」）：编辑 `base_url`、轮换 secret、发起测试登录、标
  `retired`；新建只在「无 active issuer」或「显式替换」时开放，并展示影响面（N 个账号、M 个
  商品将变 orphaned）。**向导无法证明 secret 正确**：没有动态注册，也没有无用户的校验端点，
  只能验基址可达与 `GET /api/oauth/csrf` 返回 `csrf_` cookie。真正的 `last_verified_at` 要等
  一次成功登录回调才写入，之前挂「待验证」横幅。
- secret 加密：AES-256-GCM，密钥来自 `STORE_SECRET_KEYS`（`kid:key` 列表），密文带
  `key_version`；轮换密钥只解密旧值、新写入用最新 `kid`。读穿缓存 60 s，改完不必重启。
- 轮换流程：论坛后台 rotate（单哈希覆盖，见事实 10）→ 商城粘贴新 secret → 缓存过期后生效。
  旧 secret 已失效、新 secret 未落地之间会有短暂 refresh 失败；从 `client_secret_rotated_at`
  到首次 refresh 成功之前，后台显示「待验证」。
- 登录：
  1. `GET /api/auth/sforum/start` 生成 `state` + PKCE，写短时签名 Cookie。
  2. 跳 `${base_url}/api/oauth/authorize?client_id&redirect_uri&response_type=code&scope=profile
     avatar&state&code_challenge&code_challenge_method=S256`。
  3. 回调 `GET /api/auth/sforum/callback?code&state`：验 state → CSRF 握手 +
     `POST /api/oauth/token` → `userinfo?access_token=`。
  4. 按 `(issuer_key, sub)` upsert 账号；建商城会话；论坛 token 用 AES-256-GCM 加密落库。
- 刷新：`grant_type=refresh_token`，每次轮换并写回；失败标 `reauth_required`，页面提示重登，
  不静默登出开发者。
- 登出：best-effort `POST /api/oauth/revoke`（同样先 CSRF 握手）+ 删除会话。
- 商城会话：`__Host-store_session`（HttpOnly/Secure/SameSite=Lax），PG sessions，支持「撤销其它
  设备」。
- 角色：`store_roles(account_id, admin|moderator)`，由 `STORE_BOOTSTRAP_ADMINS`
  （`issuer_key#sub`）播种；**不信任论坛用户组**。
- scope：默认 `profile avatar`；`email` 仅在开发者主动选择公开联系邮箱时申请，并在 UI 说明
  用途。
- **issuer 下线（Q1b 已裁决）**：管理员把 issuer 标 `retired` → 其账号派生为 `orphaned` →
  相关商品进「归属失效」队列，逐个人工**转移所有权**或下架。转移证据 = 目标账号已有 App
  installation 覆盖 `products.repo_id`；全程写 `audit_log`。不做自动 N 天认领。

### 5.3 数据模型

Q2/Q3 已裁决：生命周期与上游连通性双轴；release 拆三层。

- `accounts`：`(issuer_key, sub)` 唯一；username/display_name/avatar_url/email/email_verified；
  `status` 由 issuer 派生（`active | orphaned`）。
- `sessions`、`oauth_token_sets`（加密 token、过期、scope）。
- `oauth_issuers`：见 §5.2。
- `products`：`extension_id` 全局唯一、`owner_account_id`、`kind(plugin|theme)`、`repo_id`
  （首次绑定前可空）、`slug`、分类/标签、`default_locale`、`latest_stable_version_id` /
  `latest_beta_version_id`（物化列，semver 最大；不建外键，避免与 `release_versions` 循环
  依赖）、`status(draft|pending_review|published|rejected|delisted)`。
  - 可见性 = `status=published ∧ repo.upstream_state≠disconnected ∧ 至少一个 published 版本`。
    `yanked` 不在这条轴上；连通性不存产品行，见 `github_repos`。
- `product_translations`：`(product_id, locale)` → name/summary/description；回退默认语言。
- `assets`：sha256/mime/width/height/bytes/storage_key；`product_screenshots` 排序。
- `repo_releases`：`repo_id`、`github_release_id`、`tag`、`target_commitish`、`is_prerelease`、
  `body`、`etag`、`sync_state`、`last_synced_at`；唯一 `(repo_id, github_release_id)` 与
  `(repo_id, tag)`。`is_draft=true` 的 release 不入库，等 `published` 事件再处理。
- `release_versions`：`product_id`、`repo_release_id`、`version`（manifest，强 semver）、
  `channel(stable|beta)`、`state(candidate|pending_review|published|rejected|yanked|
  needs_attention)`、`sforum_version_constraint`、`capabilities`、`notes_md`、`yanked_at`、
  `yank_reason`、`detection_issue`（JSON）；唯一 `(product_id, version)` 与
  `(repo_release_id, product_id)`。
- `release_assets`：`release_version_id`、`os`、`arch`、`filename`、`size`、`sha256`、
  `upstream_asset_id`、`detection_source`；唯一 `(release_version_id, os, arch)`。只有已接受
  资产才有行；歧义候选不晋升。
- `github_installations`（`installation_id`、`account_id`、`revoked_at`、`suspended_at`）、
  `github_repos`（`installation_id`/`repo_id`/`full_name`/`private`/`archived`/`default_branch`/
  `upstream_state(connected|degraded|disconnected)` + `reason` + `checked_at`）。产品的「双轴」
  只在视图上成立，连通性只存 repo 级 —— 避免 webhook 扇出更新 N 个产品行。
- `sync_state`：ETag、last_checked、last_error、next_check_at。
- `moderation_events`、`audit_log`。
- v2 预留：`entitlements`、`licenses`。**`download_nonces` 不进 v1**（Q5 选了无状态 token）。

### 5.4 GitHub App

Q2 已裁决：一部署一 App；权限含 `Actions:read`；状态双轴；断开立即下线。

- 注册（一次性，每部署一个 App）：`Contents: read` + `Metadata: read` + `Actions: read`；订阅
  `release`、`installation`、`installation_repositories`、`repository`；回调
  `${store}/api/github/setup`；webhook `${store}/api/github/webhook`。
  - `Metadata: read` 是 GitHub 对所有 App 的强制项，列出来只为文档完整。
  - `Actions: read` 边界收窄为三条，不许漂移：① 首审页展示 release 所指 commit 的 workflow
    run 结论与链接；② `tag_commit_mismatch` 只作审核提示，永不作自动拒绝依据；③ 不下载
    artifact、不作自动发布闸门。界面禁止出现「已验证构建」这类措辞 —— 手工上传的包一样能挂在
    release 上。
  - GitHub App 权限是 App 级、安装方无法逐项勾选；v1 一次申请到位，避免以后加权限逼所有
    installation 重新授权。
- 安装：`GET /api/github/install/start` → `https://github.com/apps/<slug>/installations/new?state=…`
  → setup 回调存 `installation_id` → `GET /installation/repositories` 让开发者选仓库。
- 令牌：App 私钥签 10 分钟 JWT → `POST /app/installations/{id}/access_tokens` → 1 小时 token；
  缓存到过期前 60 s。
- Webhook：验 `X-Hub-Signature-256`；按 `X-GitHub-Delivery` 幂等；`release` 入队增量同步；
  `installation*` 与 `repository` 更新可见性。事件处理只入队，不在请求内做重活。
- **断开语义**：
  - `installation.deleted` → 该 installation 下各 repo 全部 `disconnected`；单个仓库移出
    installation → 只该 repo `disconnected`。对应产品随之**立即下线**：API 404、页面 404、
    下载 410；行位保留，同 repo 重新安装 App 后自动恢复。
  - `installation.suspended` → `degraded`：保留条目、禁用安装、下载 503。它是可恢复状态，不跟
    撤权同待遇。
  - `repository.renamed/transferred` 只更新 `full_name`（`repo_id` 不变），不改可见性。
  - 已到 `staged` 的安装不受影响 —— 包已经在 core 侧。
- 自部署矩阵：官方实例用官方 App；自部署必须注册自己的 App（部署文档给 10 分钟步骤），缺配置
  启动即失败。官方 App 不服务任何外部实例。

### 5.5 同步与自动检测

- 对每个 release 的非源码 `.zip` 资产：
  1. 下载到临时文件（≤50 MiB、90 s），校验 ZIP。
  2. 读根目录（或单层子目录）`sforum.extension.json`，按仓内 vendored `manifest-v3.schema.json`
     校验；取 `id/version/type/sforumVersion/capabilities`。注意 schema 只保证 `sforumVersion`
     非空，真正的约束校验在 core（§2.1 事实 9）；`version` 另被 core 的 `StrictNewVersion`
     强校验（事实 13），商城按同一规则解析。
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

Q5 已裁决：30 分钟、多用途、绑摘要；不承诺单次。

- 目录/详情只返回 `downloadUrl`（签名 token：asset id / sha256 / exp）+ `sha256` + `size`，不
  暴露 GitHub 原始地址。
- **TTL 推导**：安装意图 15 分钟（伴生计划 §6.8 第 7 条）+ fetch 90 s + 时钟偏移，取 30 分钟，
  留约一倍余量。不变量 `token_ttl > intent_ttl + fetch_timeout + skew` 写进测试。
- **不承诺单次性**：core worker `MaxAttempts: 3`（共 3 次尝试）且无法重新签名，单次 token 会在
  第一次网络失败后打死意图。文档与 UI 都不写「一次性链接」。
- `POST /api/v1/download-urls` 返回 `{url, sha256, size, exp}`（插件用）；`GET
  /api/v1/products/{slug}/download/{os}/{arch}` 302 到签名 URL（浏览器用）。两个入口共用同一个
  签发函数。
- **签发是匿名的**：插件没有商城会话，签发端点与公开产品页同一权限面。「已发布 = 任何人可
  安装」是产品模型本身；私有仓库只保护上游取包，不保护分发。按 IP 限流，响应 `no-store`。
- `GET /api/v1/download/{token}`：验签 → **复核**：资产存在、未 yank、`sha256` 与库内一致、
  `release_version.state=published`、`product.status=published`、
  `repo.upstream_state≠disconnected` → 用 installation token 流式转发。任一不满足 → 410
  （带稳定错误码）。
  - **不要求「是该产品当前最新版本」**：否则开发者一发新版，正在装旧版的用户立即拿 410，core
    记 `download_failed` 且无法重签 —— 这是真实竞态。此条推翻 `AGENTS.md`「分发」节现行措辞，
    该文件不在本轮可改范围，见 §11。
- 响应头：`Content-Type: application/zip`、`Content-Length`、`Content-Disposition: attachment`、
  `nosniff`、`Cache-Control: private, no-store`。
- 限流：按 token 与按 IP 各一条；公开仓库同样走代理（统一一条信任链）。

### 5.7 API（契约优先）

`contracts/store-api.yaml` → `openapi-typescript`（TS）+ `oapi-codegen`（Go client）。`/api/v1`：

- `GET /catalog?channel=&sforum=&sforumBuild=&os=&arch=&compat=&q=&category=&cursor=`（ETag）
- `GET /products/{slug}`
- `GET /products/{slug}/releases`
- `GET /products/{slug}/releases/{version}`
- `POST /download-urls`（body：`{product, version?, os, arch}`，省略 `version` = 最新 stable）
  → `{url, sha256, size, exp}`；插件签发入口，与浏览器 302 共用同一签发函数
- `GET /products/{slug}/download/{os}/{arch}` → 302 到签名 URL
- `GET /health`

错误体 `{code, message, details}`；`Cache-Control: public, max-age=60,
stale-while-revalidate=300`；分页 cursor。

> **`sforum` 语义（Q6 已裁决）**：`sforum` = 宿主 `CoreCompatibilityVersion()`，契约要求它是
> 严格 semver；但该函数对非 dev 值只做原样返回、不校验，所以商城收到后必须自己验。
> `sforumBuild` = `version.Get().Version`（可能是 `dev` / `dev-abc12`），只用于识别开发版与
> 排障。商城对每个 `release_version.sforum_version_constraint` 做 Masterminds 约束求值，
> **不做版本等值比较**（关闭 A7）。
> - `sforum` 缺失或非法 → `compatibility=unknown`，不过滤，返回全部并标「兼容性未校验」。
> - `sforum` 有效且**非** dev 构建 → 默认只返回「至少一个 published 版本满足约束、且有该
>   `os/arch` 资产」的产品；dev 构建默认 `compat=all`（2026-10-26 更新，见 §7.3.8）；
>   `compat=all` 返回全部并逐版本标 `compatible`。
> - `sforumBuild` 以 `dev` 开头 → 额外标 `estimated=true`，基准是宿主派生版本；只有没报
>   `sforum` 的老宿主才回落 `1.0.0`（2026-10-26 更新，见 §7.3.8）。文案只能写「按开发版
>   估算」，不许写「兼容」。
> - 清单里的 `sforumVersion` 非法 → 该版本 `needs_attention`，不进目录、不参与兼容判断。
> - HTTP 缓存：ETag 必须包含 `sforum` 与 `os/arch/channel/compat`，否则会把一个论坛的兼容
>   结果缓存给另一个论坛。
> - 商城永远不是兼容性的最终裁判：core 安装时的 `incompatible` 仍是权威。

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
- `capabilities: [host.api, settings.own, net.outbound]`（安装不是 capability：它在管理页
  `hostActions` 里声明；`extensions.read` 随「已装清单/更新检查」推迟到 S6）
- **不声明** `database` 块：本插件不建表、不存目录缓存（缓存进程内，见 §6.4）。
- `admin.pages: [{path:"/catalog", view:"component", menu:true, group:"应用商城",
  permission:"…", hostActions:["extension.install"], component:{…}}]`
- 设置：`catalogBaseUrl`（默认官方）、`channel`、`locale`、`cacheTtl`、`allowPrerelease`；v2 预留
  `licenseKey`（secret）。
- 前端 Vue 3 + Vite + `@sforum/admin-sdk`/`@sforum/plugin-ui`，预构建到
  `frontend/admin/dist/*.mjs|*.css`。

> `allowPrerelease` 等设置项的默认值尚未逐项写死（BR 默认值友好原则要求有推荐默认 + 一键重置）。

### 6.2 后端路由（命名空间内）

> **2026-10-24 契约变更（实测，取代本节原文）**：SForum 伴生计划已落地为
> `10c2b21e8 feat(extensions): host-mediated install action for trusted admin pages`。
> 它明确否决了「`extensions.install` 能力 + Host Command + 意图表 + worker」这条设计
> （`knowledge/decisions/2026-10-24-admin-page-host-action.md` D3/D8），改为**页面级宿主动作**：
> 清单声明 `hostActions: ["extension.install"]`，管理页调用
> `bridge.installExtension({url, sha256, expectedExtensionId, expectedType, expectedVersion})`，
> 宿主自己下载、校验摘要、比对清单身份并**只暂存**。因此：
> - 不再有 `extensions.install` 能力、安装命令、意图 id 与状态轮询；
> - 插件后端不再调 `sforum.extensions.install.*`，安装由管理页发起；
> - v1 同步执行（导航离开即取消），页面必须写明「安装期间不要关闭页面」。
> 伴生计划是本契约的唯一来源；此处按实测改写，不是重新设计。

- `GET /catalog?channel=&q=&category=&os=&arch=`：后端代理商城 `/api/v1/catalog`。
  `os/arch` 取宿主进程的 `runtime.GOOS/GOARCH`（安装对象是服务器），**不带 `sforum`**
  （D9 未提供宿主版本）→ 目录按 unknown 处理、不做兼容过滤，只展示 `sforumVersion` 约束，
  由 core 在安装时兜底拒绝。
- `GET /product/{slug}`：详情 + 版本 + 资产，同样代理。
- `POST /install-url`（body `{product, version?, os, arch}`）：代商城
  `POST /api/v1/download-urls` 拿 `{url, sha256, size, expiresAt}`，交给管理页去调
  `bridge.installExtension`。body 里**不接受 URL**，只有配置里的 `catalogBaseUrl` 会被访问。
- 已装清单 / `/updates`：需要宿主暴露已装扩展（D9 未提供），v1 不做，留 S6。

### 6.3 页面与交互

> **待定**：完整状态机（含无权限、stale 缓存、worker 超时）见 §10 下一轮议题（原阻塞项 7）。

- 侧栏一级「应用商城」；插件/主题两个页签；搜索、分类、已装徽标。兼容性筛选默认「仅兼容」，
  可切「全部」；`sforum` 缺失/非法或 dev 构建时默认「全部」，并显示「未校验」/「按开发版
  估算」徽标。
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

### 6.5 与 core 的安装交接（按 2026-10-24 落地契约改写）

1. 管理页从插件后端拿到 `{url, sha256, size, expiresAt}` 与目录里的 `extension_id`/`version`。
2. 调 `bridge.installExtension`（宿主先做权限预检，再弹它自己的确认框，然后同步安装）。
3. 成功 = **已暂存**；页面显示扩展 ID、版本、摘要 + 链接到 core 的扩展管理页，并写明
   「启用与信任在 core 完成」。
4. 失败按 `error.code` 映射：`install_permission_denied` / `install_cancelled` /
   `install_in_progress` / `install_invalid_request` / `install_failed`；身份不符由宿主报
   `extension.expected_mismatch`（在类型权限判定之前）。
5. 页面在安装期间必须写「不要关闭页面」——v1 是同步的，离开即取消。
6. 目标是已启用插件的新版本时同样只说「已暂存」，文案写「去完成升级」，不写「已更新」。

## 7. 阶段与验收

> S1–S6 细则见 §7.1–§7.6。

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| S0 | 仓库骨架、OpenAPI 契约、CI（Bun 冒烟 + Go 插件构建） | 空壳可构建；契约生成通过 |
| S1 | OAuth2 登录（CSRF 握手、refresh 轮换、会话） | 高保真 fake provider 登录/刷新/撤销通过（细则见 §7.1） |
| S2 | GitHub App 安装 + 仓库选择 + release 同步 + 自动检测 | fake GitHub fixture release 正确解析（细则见 §7.2） |
| S3 | 产品 CRUD + 图片上传 + 公开 API + 公开前台 | 细则见 §7.3：catalog ETag/兼容过滤、SSR 详情、签名下载复核、owner-only CRUD、图片魔数/内容寻址 |
| S4 | 开发者门户 + 审核后台 | 细则见 §7.4：首个产品人工审核、后续 release 按策略自动、能力/改名复审、yank/下架、事件与审计同事务 |
| S5 | 插件 MVP（目录/详情/安装/缓存） | 细则见 §7.5：清单校验、路由代理与 ETag 缓存、管理页宿主安装动作、1633×810 + 390×844 |
| S6 | 加固与文档（限流、审计、运维文档） | 细则见 §7.6：四通道限流、认证审计、三份文档、回滚演练、真实宿主端到端 |

> **进度（2026-10-24）**：S0 完成（workspace、Next.js 16 + shadcn/ui Nova、契约、CI、
> `bun --bun next build` 与 `/api/health`）；S1 完成（fake provider 验收，18 tests + curl 全流程）；
> S2 完成（GitHub App JWT/token 缓存、webhook 验签/幂等、pg-boss worker、release 同步/检测，
> 40 tests + curl）；S3 完成（目录读模型 + 公开 API + 签名下载 + 产品 CRUD/图片 + 前台接 DB，
> 214 tests + 生产构建 curl）；S4 完成（审核流 + 自动发布策略 + 开发者门户 + 审核台，
> 271 tests + 双档浏览器证据）；S5 完成（`sforum.store` 插件：清单/后端代理/管理页，
> 宿主的 validate/test/package 三道闸全绿，真实宿主安装未验证）；S6 完成（四通道限流 +
> 认证审计 + 三份运维文档 + 回滚演练）。
>
> **收尾轮（2026-10-24）**：真实 provider 契约复核并修正两处漂移（JSON 请求体、camelCase
> userinfo）+ `client_id` 启动校验；仪表盘列表 N+1 消除；审核台 GitHub Actions 提示（§7.4
> 第 25 条）；插件管理页 en-US（§7.5 第 15 条）。全量 **310 pass / 32 files**、`tsc` 干净、
> 生产构建通过、宿主三闸全绿。计划状态仍为 `active`，**转 `completed` 需人工确认**。
>
> **2026-10-26 管理页三项**：更新说明改服务端渲染（`ReleaseVersion.notesHtml`，复用 README 的
> 渲染器与白名单）、`ProductSummary.owner` 换成结构化 `author`、安装条加门禁
> （每版本 `installedRelation`）。`bun test` **784 pass / 66 files**、typecheck 干净、插件
> **128 pass**、`go test`/`vet` 绿、宿主 validate/test/brand/package 四闸全绿、真机
> 1633×810 + 390×844 验收。§7.5 第 17 条的体积预算改为**看发布产物**：`dist/catalog.css`
> 18,123 B、`dist/catalog.mjs` 52,662 B（源码 CSS 23,322 B，不再作为判据）。
> 同日晚间补丁：门禁阻断态去掉「去 core 卸载」按钮（破坏性动作不进目录手势路径）；
> `author.profileUrl` 上线，作者条里的 `@用户名` 链到论坛个人主页（`<issuer>/u/<username>`）。

### 7.1 S1 验收（2026-10-24，已通过）

选择**高保真 fake provider**（`service/test/fake-provider.ts`），不依赖真实论坛。它复刻宿主的
约束：所有插件路由在 CSRF 后；token/revoke 需要 `csrf_` cookie + `X-Csrf-Token` + `Origin`；
凭据只在 request body；userinfo 只认 `access_token` 查询参数；拒绝 `Authorization` 头。

通过条件（全部满足）：

1. `GET /api/auth/sforum/start` → 307 到 provider authorize，带 PKCE S256 与 state；state cookie
   HttpOnly / SameSite=Lax，10 分钟。
2. fake authorize → callback → 303 `/`；session cookie 设置；`accounts`、`sessions`、
   `oauth_token_sets` 落库；token 密文以 `v1.` 开头，不含明文。
3. `GET /api/auth/session` → 200，返回 account 与 roles；`STORE_BOOTSTRAP_ADMINS` 生效。
4. `POST /api/auth/refresh`（同源）→ 200；refresh 轮换；旧 refresh 失效。
5. `POST /api/auth/logout` → 200；provider revoke 被调用；session 删除；再查 session 401。
6. 负例：跨源 POST → 403；state 不匹配 → 303 `?auth_error=state_mismatch`；provider 缺 CSRF →
   303 `?auth_error=csrf_failed`。

证据：`bun test` 18 pass（6 个文件，含 Postgres 集成）；curl 全流程见
`knowledge/sessions/archive/2026-10/2026-10-24-s1-oauth.md`。

> **复核（2026-10-24，对真实 provider 的只读探针）**：用 `SforumOAuthClient` 打本机运行的
> `sforum-oauth2-provider`，发现本节选定的 fake 与真实契约有**两处漂移**，且都会让真实登录
> 直接失败：① token/refresh/revoke 的请求体必须是 `application/json`（provider 路由声明
> `additionalProperties:false`，表单编码被宿主以 **422 `extensions.route_schema_invalid`**
> 拒掉）；② userinfo 字段是 camelCase（`displayName`/`avatar`/`emailVerified`）。
> 两处已在客户端与 fake 同时修正（fake 现在按路由 schema 校验，不再只模仿语义），决策记录
> `decisions/2026-10-24-oauth-fake-mirrors-route-contract.md`；探针证据见
> `sessions/2026-10-24-s7-provider-contract-and-optional-items.md`。**完整登录仍未验证**：
> 缺一个已登记的 client secret 与一个论坛用户会话。

### 7.2 S2 验收（2026-10-24，已通过）

GitHub 侧用 fake API + fixture release，不依赖真实 App；队列与 DB 用真实 Postgres。

通过条件（全部满足）：

1. **JWT**：RS256，`iss=app_id`，`exp-iat=600s`；公钥验签通过。
2. **installation token**：进程内缓存，到期前 60 秒刷新；同 installation 连续调用只换一次 token。
3. **webhook**：正确签名 → 202；错误签名 → 401；同一 `X-GitHub-Delivery` 第二次 → 202 duplicate，
   DB 只有一行。
4. **worker**：pg-boss 消费 `github-webhook`；`installation.created` 写 `github_installations`；
   delivery 置 `processed`。
5. **安装入口**：已登录 `GET /api/github/install/start` → 307 到 GitHub App 安装页，带签名
   state（10 分钟）。
6. **release 同步**：一个 tag 挂 N 个 ZIP → N 个 `release_versions`；主题 `any/any`
   （manifest）、插件 `linux/amd64`（ELF header）；`checksums.txt` 交叉校验；同版本改摘要 →
   `needs_attention`；重复同步幂等。
7. **检测**：buildinfo → ELF/Mach-O → 文件名；每次写 `detection_source`。

证据：`bun test` 40 pass（13 个文件，含 Postgres 集成）；curl 签名 webhook → 202 → worker
`processed`；坏签名 401；重复 202；安装入口 307。

### 7.3 S3 验收（2026-10-24，本轮开工前写入）

S3 全部读路径来自真实 PostgreSQL + Drizzle 迁移；GitHub 取包用 fake fetcher，不依赖真实 App。
视觉验收（1633×810 / 390×844）按 AGENTS 归 S5，S3 只要求 SSR 输出可断言。

**通用**

1. `bun run test` 全绿；`cd service && bun --bun next build` 通过；
   `bun install --frozen-lockfile` 无变更。
2. 路由只做解码/编码与传输：业务在 `src/lib/**`，SQL 在 `src/lib/**` 的 query/store 模块；
   路由文件不出现 drizzle 查询与业务分支。
3. 公开读接口 `Cache-Control: public, max-age=60, stale-while-revalidate=300`；签发与下载
   `private, no-store`。

**catalog（`GET /api/v1/catalog`）**

4. ETag：首次 200 带 `ETag`；同参数带 `If-None-Match` → **304 且空 body**；`sforum`、
   `sforumBuild`、`os`、`arch`、`channel`、`compat`、`q`、`category`、`cursor`、`limit` 任一
   变化都改变 ETag（不同论坛/平台不得共享缓存）。304 也带 `Cache-Control`。
5. 可见性：只返回 `products.status=published` ∧ 上游 `≠disconnected` ∧ 至少一个
   `release_versions.state=published` 且 `sforum_version_constraint` 可解析的产品。
   `draft/pending_review/rejected/delisted`、`upstream_state=disconnected`、无已发布版本的
   产品一律不出现。`upstream_state=degraded` 仍返回（Q2：可恢复，只禁装；安装入口 503）。
6. `channel=stable` 只统计 stable 版本，`channel=beta` 只统计 beta，缺省为两者。
   `latestVersion` 取该频道内 semver 最大（物化列 `latest_stable_version_id` /
   `latest_beta_version_id`，缺省频道取两者较大者），**不按发布时间**。
7. `sforum` 缺失或非法（非严格 semver）→ `compatibility.status=unknown`，**版本兼容轴不
   过滤**（`total` 与不传 `sforum` 时一致）。但 `os`/`arch` 是**独立轴**：宿主总是知道自己
   的 GOOS/GOARCH，所以给了平台参数时仍按「至少一个可见版本有该平台资产」过滤。
   `compat=all` 时逐条标 `compatible|incompatible|unknown`。
8. `sforum` 有效时的默认过滤口径（**2026-10-26 更新**，见 §10.2 Q6 指针）：
   - 宿主是 dev 构建（`sforumBuild` 以 `dev` 开头）→ 默认 `compat=all`，**不过滤**。dev 的
     版本号只是宿主派生值（git tag 派生；没报版本的老宿主回落 `1.0.0`），按它过滤会产生
     假阴性；
   - 其余有效宿主 → 默认 `compat=compatible`：产品至少有一个可见版本满足约束（Masterminds
     语义；`,` 归一成空格后按 semver range 求值，求值失败按非法约束处理）；
   - 显式 `compat` 始终优先，`compatible` / `all` 照传照用，非法值 400；
   - 响应回显本次实际生效的口径：`CatalogPage.compat`（可选字段，旧客户端忽略即可）。

   `compatible` 口径下，给了 `os`/`arch` 时还要求该版本有该平台资产。`any` 是通配符而不是
   字面平台：主题按 §5.5 检测成 `any/any`，请求 `linux/amd64` 时必须仍然命中，否则平台筛选
   会把所有主题筛没。

   预发布 core 的约束求值必须与 core 对齐，**不是纯 node-semver 默认行为**：组内任一比较符
   带预发布时整组按预发布比较（组级 `includePrerelease`，对应 Masterminds 的 `containsPre`），
   仍不满足再用 `major.minor.patch` 基线重试一次（对应 `CheckSForumVersion` 的 `releaseBase`）。
   只按 node-semver 默认行为求值会把 core 能装的包藏起来 —— `>=3.0.12-alpha.7` 对
   `3.0.13-alpha.2` 就是一例。
9. `sforumBuild` 以 `dev` 开头 → `estimated=true`；判定基准是宿主报告的派生版本（git tag
   派生），只有 `sforum` 缺失/非法（老宿主）时才回落 `1.0.0` 估算。文案只能是「按开发版
   估算」。
10. `sforumVersion` 非法的版本不参与兼容判断、不出现在 releases/assets；不因此隐藏整个产品
    （还能被其它合法版本命中）。
11. `q` 大小写不敏感匹配 name/extensionId/summary/owner，`%`/`_` 转义；`category` 精确匹配；
    `limit` 1..100 默认 18；`cursor` 不透明、keyset 翻页不重不漏（`updated_at desc, id desc`）；
    非法 cursor → 400 `invalid_cursor`；非法 `channel`/`compat`/`limit` → 400 `invalid_query`。
12. `total` 是筛选后总数，与分页无关；排序稳定（同 `updated_at` 按 id 降序）。

**product（`/api/v1/products/{slug}`、`/releases`、`/releases/{version}`）**

13. `/p/{slug}` SSR：HTML 里能 grep 到产品名、最新版本与平台徽标（服务端渲染，不靠客户端
    注入）；`generateStaticParams` 不再来自 `lib/seed.ts`。
14. 非 published / 上游 disconnected / 无已发布版本 → 页面 `notFound()`，API 404，
    错误体 `{code,message}`；不出现 401/403（越权一律 404）。
15. 详情版本与资产全部来自 DB：`releases[]` semver 降序，只含 `published` 与 `yanked`
    （`needs_attention` 不外露）；`assets[]` 来自 `release_assets`；单平台版本 `digest` 等于
    该资产 sha256。
16. `/releases/{version}` 精确匹配 manifest 版本（不做 `v` 前缀容错）；不存在 → 404。

**download**

17. `POST /api/v1/download-urls` 匿名可用（无 Cookie 也 200）；body `{product, os, arch,
    version?}`；省略 `version` 取该产品最新 stable（无 stable → 404）；body 非法 → 400。
18. token = `base64url(payload) + "." + base64url(HMAC-SHA256(payload, STORE_DOWNLOAD_SECRET))`；
    payload 含 `a`(release_asset id)、`s`(sha256)、`e`(exp 秒)。TTL 恒 30 分钟。
    不变量测试：`token_ttl > intent_ttl(900s) + fetch_timeout(90s) + skew(60s)`。
19. 响应 `{url, sha256, size, expiresAt}`；`url` = `${STORE_PUBLIC_URL}/api/v1/download/{token}`；
    任何公开响应都不出现 `browser_download_url`、`github.com` 或 installation token。
20. `GET /api/v1/products/{slug}/download/{os}/{arch}` → 302 到同一签发函数产出的 URL。
21. `GET /api/v1/download/{token}`：验签 → 复核（资产存在、版本 `published`（即未 yank）、
    token.sha256 与库一致、产品 `published`、上游 `≠disconnected`）→ 流式转发上游 ZIP。
    **不要求是当前最新版本**：发布 v2 后 v1 旧 token 仍 200。
22. 失败一律 410 + 稳定错误码：`token_invalid` / `token_expired` / `asset_missing` /
    `release_unpublished` / `product_unpublished` / `digest_mismatch` /
    `upstream_disconnected`；上游 suspended（degraded）→ 503 `upstream_degraded`。
23. 响应头齐全：`Content-Type: application/zip`、`Content-Length`（取库内 size）、
    `Content-Disposition: attachment; filename="..."`、`X-Content-Type-Options: nosniff`、
    `Cache-Control: private, no-store`；**流式**（不把 50 MiB 读进内存）。

**产品 CRUD（`/api/dashboard/**`，session 鉴权）**

24. `POST /api/dashboard/products`：登录用户建草稿（`status=draft`、
    `owner_account_id=session.account.id`）；`extension_id` 匹配清单 ID 形式
    （`^[a-z0-9][a-z0-9._-]{2,63}$`）且**全局唯一** → 冲突 409 `extension_id_taken`；
    `slug` 缺省由 name 生成并去重（`-2`、`-3`），显式 slug 需匹配
    `^[a-z0-9][a-z0-9-]{1,63}$` 且唯一 → 409 `slug_taken`。
25. `GET/PATCH/DELETE /api/dashboard/products/{id}`：owner-only；**他人产品一律 404**
    （不 403、不泄漏存在性）。PATCH 不接受 `status`/`owner_account_id`/`repo_id`（审核与绑定
    面）；DELETE 是软删（`status=delisted`）。
26. 每个受保护路由都有 allowed + denied 用例：匿名 401、非 owner 404、owner 200。
27. 文案落 `product_translations`（`(product_id, locale)` 唯一），默认 locale 缺失时回退
    `products.name`；`description_md` 按纯文本转义输出（`<script`/`<svg` 等标签被拒绝或转义），
    富文本渲染留 S4/S5。

**图片**

28. `POST /api/dashboard/products/{id}/icon` 与 `/screenshots`（multipart）：只接受
    PNG/JPEG/WebP；`file-type` 读魔数为唯一判据（不看扩展名与 `Content-Type`）；
    `image-size` 取宽高；SVG/GIF/BMP 及任何非白名单 → 415 `unsupported_image`；文本
    `<svg` 伪装成 `.png` 同样拒绝。
29. 上限：单边 ≤ 4096 px、字节 ≤ 4 MiB、宽高 > 0；超出 → 413 `image_too_large` /
    415 `image_dimensions_too_large`。
30. 内容寻址：`assets.sha256` 唯一；存储键 `sha256[0:2]/sha256[2:4]/sha256`；同内容重复上传
    幂等（不新增行、不写第二个文件）。
31. 截图 `position` 0..n，重排接口接受完整 id 数组（必须恰好覆盖现有集合，否则 400），
    最多 8 张，超出 → 409 `too_many_screenshots`。
32. `GET /api/assets/{sha256}`：`Content-Type` 取库内 mime、`Cache-Control: public,
    max-age=31536000, immutable`、`nosniff`；未知 sha256 → 404。
33. **不存 ZIP**：`assets` 只服务图片；`release_assets` 仍只有 sha256/尺寸，没有 storage_key。

**种子与前台**

34. `service/src/lib/seed.ts` 不再被运行时引用（`rg "lib/seed" service/src` 为空）；
    `service/scripts/seed-dev.ts` 只在本地手动跑（`bun run seed:dev`），不参与构建。
35. 目录页与详情页读 DB；空库显示空状态不 500；页面 `dynamic = "force-dynamic"`，
    `next build` 不需要数据库连接。

**证据（2026-10-24）**：`bun test` **214 pass / 0 fail**（23 文件，含真实 Postgres）；
`bun --bun next build` 通过（26 条路由，`/` 与 `/p/[slug]` 动态）；`bun install --frozen-lockfile`
无变更。curl 全流程（catalog 200/ETag/304、兼容过滤、SSR、签发/篡改 410、yank 立即 410、
断开立即 404/410、degraded 目录保留 + 下载 503、图片 200/415、dashboard 401/409/404/403/415）
见 `knowledge/sessions/archive/2026-10/2026-10-24-s3-catalog.md`。

**契约增补（S3，全部向后兼容）**：`ProductSummary` 新增可选 `category` / `tags` / `iconUrl`，
`owner` 改为可空；`ProductDetail` 新增必填 `screenshots[]`、`repoUrl` 改为可空、`permissions`
改为可选（权限目录 S4/S5 定稿，S3 用 `releases[].capabilities`）；`ReleaseVersion.digest` 改为
可选（多平台版本以 `assets[].sha256` 为准）、新增可选 `notes`（已消毒纯文本）。`src/lib/api-types.ts`
已按契约重新生成。

### 7.4 S4 验收（2026-10-24，本轮开工前写入）

目标：开发者门户 + 审核后台。首个产品人工审核；之后的新版本按策略自动发布，只有「未审过的
能力 / 改名」这类情形才回到人工。全部状态变更写 `moderation_events` + `audit_log`，且与状态
同事务。

**通用**

1. `bun test` 全绿；`cd service && bun --bun next build` 通过；`bun install --frozen-lockfile`
   无变更。
2. 路由只做解码/编码；SQL 在 `src/lib/**` 的 store/service 模块，路由文件不出现 drizzle import。

**产品生命周期（开发者侧）**

3. `POST /api/dashboard/products/{id}/submit`：owner-only；`draft|rejected → pending_review`；
   要求至少一个 `candidate|pending_review` 版本且默认语言文案非空，否则 409
   `no_reviewable_version` / `missing_copy`；重复提交（已在 `pending_review`）幂等返回 200。
4. 非 owner → 404；非 `draft|rejected|pending_review` 状态（如已 published/delisted）→ 409
   `invalid_state`。每次真实提交写 `moderation_events(draft|rejected → pending_review,
   action=submitted)` 与 `audit_log`。
5. 被拒后可改文案再提交；历史事件不删除。

**审核（moderator / admin）**

6. `/api/moderation/**` 仅 `store_roles` 含 `moderator|admin`：匿名 401，无角色 403
   `forbidden`；`/moderation` 页面无角色时 `notFound()`（404，不泄漏存在性）。
7. `GET /api/moderation/queue`：返回待审产品（`pending_review`）与等审版本（产品已
   `published` 但版本 `pending_review`），含扩展 ID、类型、提交人、等待时长、版本数、能力集合。
8. `POST /api/moderation/products/{id}/approve`：`pending_review → published`；该产品所有
   `candidate|pending_review` 版本 → `published` 且 `published_at=now()`；写快照
   `name_at_review` / `repo_id_reviewed` / `capabilities_reviewed`（这些版本的并集）；
   产品 `published_at` 首次写入；重算 latest；写事件与审计。
9. `POST /api/moderation/products/{id}/reject`：`reason` 必填 1..500 字；`pending_review →
   rejected`；版本状态不变（便于改后重提）；写事件与审计。
10. `POST /api/moderation/versions/{id}/approve|reject`：处理等审版本。approve 要求产品已
    `published`（否则 409 `product_not_published`），approve 后 `published_at=now()` 并重算
    latest、把该版本能力并入 `capabilities_reviewed`；reject → 版本 `rejected`（公开 API 不可见）。
11. 状态机严格：对非待审目标操作 → 409 `invalid_state`；重复 approve 不产生第二条事件。

**后续 release 自动发布**

12. `syncRelease` 决定版本状态的策略（`lib/moderation/policy.ts`，纯函数 + 测试）：
    - 产品不是 `published` → `pending_review`；
    - 产品 `published` 且 `versions.capabilities ⊆ products.capabilities_reviewed`，且
      `products.name === name_at_review`，且 `repo_id === repo_id_reviewed` → `published`
      （`published_at=now()`，重算 latest）；
    - 否则 → `pending_review`，并写 `moderation_events(action=re_review_required)`（actor 为
      null 表示 system）。
13. **保守口径**：v1 不区分能力风险等级，任何未审过的能力键都触发复审；此条写进决策记录，
    风险分级留 S6。
14. 自动发布不改变已发布版本的不可变性：同版本换摘要仍是 `needs_attention`（Q4 不变）。

**Yank / 下架**

15. `POST /api/dashboard/versions/{id}/yank`（owner）：`published → yanked`，`reason` 必填；
    重算 latest；写事件与审计；立即影响下载（旧 token 410）与详情状态列。
16. `POST /api/moderation/products/{id}/delist`（moderator）：`published → delisted`，理由必填；
    目录消失、详情 404、下载 410；写事件与审计。`delisted` 只能经重新提交与审核回到线上。

**审计与事件**

17. `audit_log`：actor、action、target_type、target_id、details(JSON)、ip、created_at；
    提交 / 批准 / 拒绝 / 自动发布 / 复审 / yank / 下架都有行。
18. `moderation_events`：subject（product 或 version 二选一）、from_state、to_state、action、
    actor（system 为 null）、reason、created_at。
19. 事件与审计写入与状态变更**同一事务**，任一步失败整体回滚（测试用注入错误验证）。

**开发者门户 UI**

20. `/dashboard`：登录后列出自己的产品（DB 数据）、状态徽标、最近一次拒绝原因；未登录
    307（`next/navigation` 的 `redirect()`）到 `/api/auth/sforum/start?redirect=/dashboard`；
    空态清晰。
21. `/dashboard/products/[id]`：编辑文案/分类/标签、上传图标与截图（dnd-kit 拖拽排序）、
    提交审核、yank 版本；成功给 Toast，阻塞错误留在表单旁且不自动消失。
22. 页面 1633×810 与 390×844 截图证据：无横向溢出、交互元素有可访问名称。

**审核台 UI**

23. `/moderation`：`react-resizable-panels` 左右分栏（队列 + 详情）；详情展示版本列表、
    能力集合与 `capabilities_reviewed` 的差异、提交人、事件时间线；**拒绝与下架**必须填
    1..500 字理由，**批准**是确认对话框（不填理由，审计只记 actor/目标/时间）。
24. 视觉同上：1633×810 与 390×844。

**GitHub Actions 提示（可选，非闸门）**

25. 首审页在 GitHub App 已配置且仓库已绑定时展示 release 所指 commit 的 workflow run 结论
    与链接；未配置或请求失败时静默省略；界面禁止出现「已验证构建」措辞，它也永远不参与
    批准判定。

**证据（2026-10-24）**：`bun test` **271 pass / 0 fail**（28 文件，含真实 Postgres）；
`bun --bun next build` 通过（`/dashboard`、`/dashboard/products/[id]`、`/moderation` + 7 条审核
API 全动态）；`bun install --frozen-lockfile` 无变更。curl 全流程（提交 409→200、401/403/404
角色门、403 跨源、批准落库与快照、拒绝理由回显、API yank 后旧 token 410 且 latest 重算）与
1633×810 / 390×844 截图见 `knowledge/sessions/archive/2026-10/2026-10-24-s4-moderation.md`。

> **第 25 条已于 2026-10-24 补齐**（原记「可选、未实现」）：`src/lib/github/actions.ts` 按
> release 的 target commit 取 workflow run（2.5 s 预算、最差结论优先），
> `components/moderation/workflow-hint.tsx` 只在「App 已配置 ∧ 仓库已绑定 ∧ 有等审版本」时
> 渲染，未配置/404/401/超时/形状不符一律不渲染且不抛；文案写明「参考信息，不参与审核判定」，
> 测试对「已验证构建」及英文等价做源码级扫描。证据：
> `sessions/2026-10-24-s7-provider-contract-and-optional-items.md`。

### 7.5 S5 验收（2026-10-24，本轮开工前写入）

插件 `plugin/plugins/sforum.store/`：清单 + Go 后端代理 + 预构建管理页。安装按
**2026-10-24 落地的宿主动作**（`bridge.installExtension`）实现，不使用已否决的命令/worker
设计（见 §6.2 的契约变更说明）。

**清单与打包**

1. `sforum.extension.json` 通过 SForum 的 Manifest V3 校验：用 SForum 检出里的
   `schemas/manifest-v3.schema.json` 做离线校验（脚本 + 输出留证），并在 Go 单测里用
   SForum 的 `ExtensionManifest` 解析器跑一遍。
2. 清单内容：`id: sforum.store`、`type: plugin`、一个 `view: component` 管理页 `/catalog`
   （`hostActions: ["extension.install"]`、`component.entry` 指向预构建 `.mjs`）、
   `manifest/settings.json` 声明 `catalogBaseUrl`（默认官方商城）与 `channel`（stable|beta）。
3. 能力最小化：不声明 `extensions.install`（该能力不存在于落地契约）、不声明未使用的
   `users.*`；若 `net.outbound`/`extensions.read` 在 V3 里不存在，则如实不写。
4. 包内**不出现源码地图、node_modules、Vue SFC 与 Vite 配置**；`packageFiles` 与实际文件
   一致；`backend.digest` 由 SForum 的打包命令生成。
5. 离线可重复构建：`plugin/scripts/build.sh`（或等价）产出 `frontend/admin/dist/*.mjs` +
   `backend/plugin`，并打印各产物的 sha256。

**后端（Go）**

6. 三条路由，全部 JSON + 显式 `Content-Type`，且只做代理/转换：
   `GET /catalog`、`GET /product/{slug}`、`POST /install-url`（body
   `{product, version?, os, arch}`）。
7. 上游只访问配置的 `catalogBaseUrl`：请求体不接受 URL；`os/arch` 取
   `runtime.GOOS/GOARCH`；**不发送 `sforum`**（宿主未暴露版本）→ 目录 `compatibility=unknown`
   且不过滤；不在响应里回显上游失败细节。
8. ETag 缓存：按查询键保存 `etag` + body，带 `If-None-Match` 请求；304 复用缓存；TTL 10 分钟；
   上游失败时最多用 24 小时内的 stale 数据，并在响应里标 `stale: true` + `fetchedAt`。
9. 超时与上限：上游 10 秒超时、响应体 ≤ 4 MiB、`install-url` 只透传商城返回的签名 URL。
10. 单测用 `httptest` + 假上游覆盖：200/304/超时/5xx→stale/超大响应/未知 slug/安装签发透传；
    `go vet` 与 `go test ./...` 全绿。

**管理页（预构建 ESM）**

11. 模块导出 `{ apiVersion: 1, mount(target, bridge) }`，返回清理函数（测试可见节点被移除）。
12. 目录：真实调用插件后端；channel/关键词/分类筛选、cursor 翻页、空态与错误态；详情展示
    版本、平台、`sforumVersion` 约束、能力、摘要与前 12 位摘要。
13. 安装：先对 `bridge.installExtension` 做**特性检测**。存在 → 调
    `{url, sha256, expectedExtensionId, expectedType, expectedVersion}`；成功文案是
    **「已暂存」** + 去 core 扩展页完成信任/启用 + 「安装期间不要关闭页面」。
    不存在（旧宿主）→ 明确说明「当前宿主不支持页面内安装」，提供复制签名链接，绝不假装安装。
14. 错误码映射：`install_permission_denied` / `install_cancelled` / `install_in_progress` /
    `install_invalid_request` / `install_failed` / `extension.expected_mismatch` 各自的中文文案；
    页面内单飞（并发第二次调用被拒并提示）。
15. 文案禁语：不出现「已安装」「已更新」「已验证构建」「自动升级」；启用/信任一律指向 core。
16. 页面只通过 `bridge.request` 访问插件后端，**不发任何跨域请求**，不加载外部字体/图标；
    手写 ESM 没有 Host 图标运行时 → 按钮用文字，不用 emoji、不内联 SVG。
17. 体积预算：单个 `.mjs` ≤ 80 KB、CSS（若有）≤ 20 KB。

**测试与证据**

18. 前端逻辑（纯函数 + mount）在 Bun 的 DOM 测试里跑：假 `bridge` 断言目录渲染、安装参数、
    错误码文案、清理函数；不含真实网络。
19. 真实 SForum 端到端（安装到暂存）为目标项：能廉价启动宿主则留证据（截图/日志），
    不能则明确写「未验证」+ 给出复现命令，不允许用「应该可以」带过。
20. 浏览证据：管理页 1633×810 与 390×844 截图（无横向溢出、可访问名称），安装在两种宽度下
    都可用。

**证据（2026-10-24）**：
- 后端 `go test ./...` **28 个顶层用例全绿**（含 `-race`）、`go vet` 干净。
- 管理页 `bun test plugin/plugins/sforum.store/frontend/admin/src` **28 pass / 106 expect**；
  产物 `catalog.mjs` 25,707 B、`catalog.css` 14,401 B（预算 80 KB / 20 KB）。
- 宿主自己的命令（SForum `10c2b21e8`）：`sforum extension validate` → **OK**（3 routes、
  1 admin page、2 settings、`v3.packageFiles: 9`）；`sforum extension test` →
  **PASS，0 errors / 0 warnings / 6 checks**。
- `sforum extension package --exclude-source` → 14 个文件、跳过 19 个源文件，
  ZIP digest `ae4be719…`，SBOM 一并产出。
- 第 19 条（真实宿主端到端安装到暂存）**未验证**：本机没有可直接启动的宿主构建，见下。
- 第 20 条的宿主内嵌渲染未验证；管理页用真实 `dist` bundle + 宿主 CSS 变量在
  1633×810 / 390×844 两档渲染，无横向溢出、13 个交互元素全部有可访问名称。

> **2026-10-24 补充**：第 15 条（en-US）已做：`frontend/admin/src/copy.ts` 双语文案表
> （各 109 key，键集一致），按 `bridge.locale` 判定（`en*` → en-US，缺失 → zh-CN），
> `catalog.mjs` 25,707 → **35,284 B**（预算 80 KB）、`catalog.css` 14,401 B 字节未变；
> 管理页测试 28 → **43 pass / 439 expect**，含「全 ASCII fixture 下 en-US 渲染无 CJK」的硬证据。
> 第 20 条仍是未验证项（本轮只改文案，CSS 字节未变）。

> **2026-10-26 补充**：管理页目录改为卡片网格 + 挂 `body` 的详情弹窗（容器查询 1120/940/552 →
> 4/3/2/1），取舍见 `decisions/2026-10-26-catalog-card-dialog.md`，证据与已知限制见
> `sessions/2026-10-26-catalog-card-dialog-handoff.md`。

**本轮过程中修正的两条宿主契约事实**（都写进了 `decisions/2026-10-24-s5-plugin-admin-page.md`
与 §6.2）：
1. 宿主对**任何状态码**都会把响应体按路由 `responseSchema` 校验，所以错误文档必须绑定到
   **本路由**的 schema；三条路由的响应 schema 因此是「成功 | 错误」联合。
2. OpenAPI 片段需要 `x-sforum-route-id` / `-contract-version` / `-guard` / `-request-schema` /
   `-response-schema` 与 `200` + `default` 两个响应，且被引用 schema 文件里的 `$id` 必须等于
   路由声明的 `responseSchema`；否则 `extension validate` 报 `route schema is missing`。

### 7.6 S6 验收（2026-10-24，本轮开工前写入）

目标：加固与文档。yank/下架/审计在 S4 已落地，本轮补**限流**、**运维文档**、**回滚演练**，
并把「真实宿主端到端」从 S5 的未验证项推进到可复现步骤。

**通用**

1. `bun run test`、`cd service && bun --bun next build`、插件 `go test` 与管理页 `bun test`
   全绿；`bun install --frozen-lockfile` 无变更；`bunx tsc --noEmit` 干净。

**限流（AGENTS「每个动作独立限流」）**

2. 存储用 Postgres 固定窗口计数（新表 `rate_limits(bucket, window_start, count)`，
   `(bucket, window_start)` 唯一，写入为原子 upsert），**不引入 Redis 客户端**；多副本共享
   同一份计数；过期窗口在写入路径顺手清理，不需要后台任务。
3. 四个独立通道，默认配额可配置（env 覆盖，测试注入）：
   - `login`：按 IP，10 次 / 5 分钟，作用于 `/api/auth/sforum/start` 与 callback；
   - `submit`：按账号，30 次 / 小时，作用于 dashboard 的写操作（创建/改文案/提交/上传/撤回）；
   - `download`：按 IP 与按 token 各一条，作用于 `/api/v1/download-urls` 与
     `/api/v1/download/{token}`；
   - `repo`：按账号，30 次 / 小时，作用于 `/api/github/install/start`。
4. 触发时返回 **429**、`{code:"rate_limited", message}`、`Retry-After`（秒，向上取整到窗口
   结束）与 `Cache-Control: no-store`；响应体不暴露内部计数或窗口键。
5. **fail-open**：限流存储不可用时不阻断请求，记一条 `log.Printf` 告警；不能因为限流表挂了
   把登录和下载一起打死。
6. 测试：窗口内第 N+1 次 429、跨窗口恢复、不同 key 互不影响、fail-open、`Retry-After` 数值、
   四个通道互不串扰。

**审计**

7. 认证事件进 `audit_log`：`auth.login.succeeded` / `auth.login.failed`（带原因码与 IP），
   与 S4 的产品/版本审计共用同一条时间线；限流触发只写日志（避免攻击时把审计表打爆）。
8. 审计查询只读接口不做；`audit_log` 由运维直接查库，文档给出 SQL 示例。

**文档（`docs/`）**

9. `docs/deployment.md`：部署矩阵（官方/自部署/离线后续）、必需与可选环境变量表、GitHub App
   注册步骤（权限 `Contents/Metadata/Actions: read`、四个事件、回调与 webhook 路径）、
   Postgres/pg-boss、Bun 运行时闸门与 Node 回退的判定、备份与恢复（数据库 + 资产卷）、
   升级与回滚清单、限流默认值表。
10. `docs/plugin.md`：插件安装（URL + sha256 手动安装或目录装配）、设置项、安装只到 `staged`、
    旧宿主降级行为、对商城的出站与 TLS 要求、故障排查（not_configured / upstream_error /
    expected_mismatch）。
11. `docs/developer.md`：开发者接入全流程（SForum 登录 → 安装 GitHub App → 同步 release →
    提交审核 → 审核结果 → yank），图片规范（PNG/JPEG/WebP、4 MiB、4096px、禁 SVG），
    版本语义（manifest 为准、`sforumVersion` 是约束）。
12. 文档里的命令与 env 必须与本仓一致（可执行、无「应该」）；每条运维动作给出验证方式。

**演练**

13. **回滚演练**（本地可复现，留命令与输出摘要）：`pg_dump` 备份 → 制造变更（yank 一个版本
    或 delist 一个产品）→ 恢复到新库 → 服务指向新库启动 → `/api/health` 200 且目录/详情恢复；
    资产卷缺失时的表现也要记录（图片 404，不崩）。
14. **真实宿主端到端**：按 SForum 的 `APP_ENV=development` + `EXTERNAL_EXTENSION_ROOTS`（或
    compose）装配插件包，在管理页点一次安装，确认停在 `staged`。环境无法启动时明确写
    「未验证」+ 完整复现步骤，不允许用「应该可以」代替。
15. 插件管理页 en-US 文案：**可选**。不做则记入 Open，不阻塞 S6。

**收尾**

16. 更新本文件（§7.6 证据、进度、§11）、`knowledge/index.md`、`plans/README.md`、
    `docs/`、新的热交接；计划状态仍为 `active`（完成需人工确认）。

**证据（2026-10-24）**：
- 限流：新增 `rate_limits` 表（迁移 `0005`）与 `src/lib/ratelimit/**`；`bun test` **280 pass**
  （新增 9 个：窗口/重试秒数/独立桶/跨窗口/fail-open/规则解析）。实测（生产构建，把限流压到
  3/300 与 2/300）：登录第 4 次 **429 + `Retry-After: 19` + `no-store`**；`download-urls` 第 4 次
  429；dashboard 写操作第 3 次 429 而 GET 不受影响；计数落在 `rate_limits`，key 不含 token 原文。
- 审计：登录成功/失败都写 `audit_log`（`auth.login.succeeded|failed`，带原因码与 IP），
  审计写入失败不阻断登录。
- 文档：`docs/deployment.md`（矩阵/env/GitHub App/备份恢复/升级回滚/限流表）、
  `docs/plugin.md`（安装、设置、暂存语义、网络要求、故障排查）、`docs/developer.md`
  （接入全流程、图片规范、版本语义、发布清单、FAQ）。
- 回滚演练：`pg_dump --format=custom`（100,679 B）→ 制造变更（yank 1.4.2 + delist search-site）
  → `pg_restore` 到新库 → 服务指向新库启动：`/api/health` 200、目录恢复 4 个产品、
  `1.4.2=published`；把 `STORE_ASSET_DIR` 指到空目录后图片 404、产品页仍 200（不崩）。
- 真实宿主：SForum 自带的安装链集成测试在本机通过（`go test ./bootstrap -run
  TestReferenceSEOFormalZipUploadTrustEnableRestartDisableUpgradeUninstall`，**ok 11.09s**，
  真实 Postgres + 真实协议子进程）。
- **本插件包的真实宿主装配（2026-10-24，成功）**：用 `APP_ENV=development` +
  `EXTERNAL_EXTENSION_ROOTS=<repo>/plugin` 启动 SForum API（本地 Postgres + Redis：
  `BUILTIN_EXTENSION_ROOT` 指向空目录以绕开检出里 builtin 二进制的摘要不一致），宿主：
  1. 构建并接收我们的包（`dev plugin watcher: package built … sforum.store`）；
  2. 把包复制进 exact-artifact 存储 `storage/extensions/sforum.store/0.1.0/<package_digest>/`；
  3. 落库 `extensions`：`id=sforum.store, type=plugin, name=应用商城, status=enabled,
     source=uploaded, staged=true, active=true`；
  4. 以 go-plugin 协议**启动了我们的 `backend/plugin` 子进程**（`ps` 可见该路径）；
  5. 注册了路由：`GET /api/v1/extensions/sforum.store/api/store/catalog` 与 `.../product`
     返回 **401 `auth.required`**（清单 `core.guard.login` 生效），未知子路径 404。
  未验证的部分：带登录会话的页面点击与 `bridge.installExtension` → `install-from-url` 的
  真实跳转——宿主下载器强制**公网 HTTPS**（`AllowHTTP/AllowPrivate` 是 test-only），本地
  没有公网可达的 HTTPS 源，这是环境约束而不是实现缺陷；复现步骤见下。
- `bun run test` **280 pass / 30 files**；`bun --bun next build` 通过；插件 `go test` 28 用例、
  管理页 28 用例、宿主 `validate`/`test`/`package` 仍全绿。

> **收尾（2026-10-24，本轮）**：第 15 条 en-US 已做（见 §7.5 补充）；三段门重新跑在最新产物上：
> `bun test --parallel=1` → **310 pass / 0 fail / 1239 expect / 32 files**、
> `bunx tsc --noEmit` 干净、`bun --bun next build` 通过、`bun install --frozen-lockfile` 无变更；
> 管理页 43 用例、后端 `go vet`+`go test` ok；宿主 `validate` OK（3 routes / 1 admin page /
> 9 packageFiles）、`test` PASS（0 errors / 0 warnings / 6 checks）、
> `package --exclude-source` → 14 文件 + digest `8437176f…` + SBOM。
> 第 14 条的真实宿主端到端**仍停在「装配 + 暂存 + 启用 + 后端启动 + 路由注册」**；
> 带登录会话的点击安装与服务端 `install-from-url` 抓取仍未跑，原因见 §11 第 10 条。

## 8. 风险与未决

**风险**

- **Bun + Next 生产运行时**：以 CI 冒烟为准；失败仅回退 `next start`。
- **GitHub App 全量**：公开仓库开发者也需安装；自部署需自建 App。文档必须写清失败提示。
- **OAuth provider 的 CSRF/cookie 约束**：S1 用高保真 fake 覆盖（`test/fake-provider.ts`）；
  真实论坛登录仍未跑，S5 前补一次真实 provider 冒烟。
- **GitHub App 真实链路**：S2 用 fake API + fixture release；真实 App 的安装、私有仓库、
  webhook 重放仍未跑，S5 前补一次。
- **清单 schema 漂移**：service vendored schema + CI 与 SForum tag 对比，漂移即失败；对比目标
  （tag / commit / main）未定。
- **扩展 ID 抢注**：`extension_id` 全局唯一 + App 安装即归属；归属键是 `(issuer_key, sub)`。
  Q1b 给了回收路径（人工转移 + App 安装证据），但 **App installation 只证明对仓库的管理权，
  不证明作者身份** —— 转移仍是人工判断，政策必须写清争议处理。
- **带宽**：全量代理是刻意选择；CDN/直链快路径留到后续。

**未决**：A9 部分关闭（S1/S2 已写；S4 仍开放）；Q1–Q6 已裁决（§10.2）；Q6 的实现依赖
SForum 侧暴露宿主版本（§10.4）；下一轮见 §10.3。

## 9. 假设

- 论坛已安装并启用 `sforum-oauth2-provider`，商城 client 已在论坛后台注册。
- 商城以 public HTTPS 暴露，能被论坛 API 访问。
- SForum 插件后端为 Go；非 Go 后端走头部/文件名兜底并标记检测来源。
- 首版不含支付/授权；数据模型预留。
- PostgreSQL 16+；不引入 Redis。

## 10. 讨论台账（2026-10-24 第一、二轮）

### 10.1 第一轮已识别缺口（状态已更新）

| # | 位置 | 问题 | 状态 |
| --- | --- | --- | --- |
| A1 | §5.2 / §5.10 | 多 issuer 同时写成「配置已支持」和「未决」 | **已关闭**（Q1：单 issuer + 稳定 `issuer_key`） |
| A2 | §5.6 ↔ 伴生 §6.8 | 下载 token 5 分钟，安装意图 15 分钟 | **已关闭**（Q5：30 分钟、多用途） |
| A3 | §5.3 / §5.6 | token 带 nonce，`download_nonces` 却排到 v2 | **已关闭**（Q5：v1 无状态，不承诺单次） |
| A4 | §5.5 ↔ §8 | 「同 release 同 extension id」与 monorepo 互斥 | **已关闭**（第一轮按事实 8 改写；Q3 用三层固化） |
| A5 | §5.3 | 产品 status 与 release yanked、上游断开挤在一条 enum | **已关闭**（Q2：双轴 + yank 归 release_version） |
| A6 | §5.3 | tag 冲突、同版本换摘要均无规则 | **已关闭**（Q4：tag 只作展示、不参与版本裁决 + 整版不可变） |
| A7 | §5.7 + 事实 9 | `sforumVersion` 是约束不是版本号 | **已关闭**（Q6：约束求值；版本暴露待 SForum 落地） |
| A8 | §5.3 / D3 | 归属绑 `(issuer, sub)`，issuer 下线后无回收 | **已关闭**（Q1b：人工转移 + App 证据） |
| A9 | §7 | S1/S2/S4 验收没有可判定条件 | **部分关闭**：S1/S2 细则已写（§7.1/§7.2）；S4 仍开放 |

### 10.2 第二轮裁决（Q1–Q6，2026-10-24）

**Q1 身份拓扑 → 单 issuer + 稳定 `issuer_key`；client 由后台向导管理、secret 加密落库；
issuer 下线走人工转移。**

- `issuer_key` 是运营方指定、永不复用/改名的稳定标识；URL 只是配置。理由：论坛换域名不能让
  全体账号与商品归属一起失效。
- 首条 issuer 由 env 种入（否则没人能登录去用向导）；之后 env 只做种子，不覆盖库内值。
- 向导只能验连通性与 CSRF 形状；secret 正确性要等首次成功登录才写 `last_verified_at`。
- 转移证据 = 目标账号已有 App installation 覆盖该仓库；逐案人工 + 审计 + 成文政策。
- 代价：后台多一套 issuer 管理面与加密密钥轮换；放弃 B（每加 issuer 一次人工建 client，且要
  信任 N 个论坛的身份断言）、C（账号发放权外放）。

**Q2 GitHub App → 一部署一 App；权限含 `Actions:read`；双轴；断开立即下线。**

- `Actions:read` 只作审核信号，不作发布闸门；禁止「已验证构建」措辞。
- `deleted` / 移出 installation = `disconnected`：API 404、页面 404、下载 410，重连自动恢复；
  `suspended` = `degraded`：保留条目、禁装、下载 503。
- 代价：仓库转移/重装期间产品短暂消失，靠 webhook + 每小时兜底在一个周期内恢复；放弃共享
  public App（官方成为所有自部署实例私有仓库的中间人）与单 enum（yank 与 disconnected 抢字段）。

**Q3 数据建模 → 三层 `repo_releases → release_versions → release_assets`；channel/state/yank
全落 `release_version`。**

- 一个 tag 挂 N 扩展：tag 级元数据只存一份，单扩展失败不污染同 tag 其它扩展。落地方式与取舍见
  `knowledge/decisions/2026-10-26-single-extension-failure-isolation.md`。
- `(release_version_id, os, arch)` 唯一；歧义候选不晋升，版本停在 `needs_attention`。
- 代价：多一次 join 与一套 tag 级同步状态机；整仓下架是批量操作 + 审计。放弃两层（tag 元数据
  重复、etag 无处落）与「产品=仓库」（monorepo 无法表达）。

**Q4 版本语义 → 版本以 manifest 为准；允许非单调；整版不可变；预发布双信号。**

- tag 不参与版本裁决，只作展示字段：`release.tag` 只写进 `repo_releases.tag` 供界面显示，版本
  只认清单 `version`；全仓没有 tag↔version 比较，也没有 `tag_mismatch` 错误码。理由：tag 是人
  打的标签，让它决定发布状态等于让一次笔误卡住整次发布。曾拟三分支（版本形 `v?X.Y.Z` + 单
  扩展组必须相等、否则 `needs_attention`；非版本形与多扩展组不比），2026-10-26 否决，与
  `AGENTS.md`「版本以清单为准，tag 只是标签」同一口径。
- `(product_id, version)` 未用过即可发布；`latest_stable/latest_beta` 按 semver 最大物化，
  不按发布时间。代价：排序、更新检查、`/releases/{version}` 的「最新」语义全部走 semver。
- 发布后任何新摘要（含新增平台）→ `version_conflict`；同 tag 同摘要重投 = 幂等 no-op。代价：
  忘打某平台要发补丁版本。
- `is_prerelease || semver prerelease` → `channel=beta`；`is_draft` 不入库。
- 派生：**接受** `+build`，与宿主清单校验对齐（`format: semver`，santhosh-tekuri
  `validateSemver`）—— 商城拒掉它等于挡下宿主本来能装的包。代价：仅 build metadata 不同的版本
  （`1.2.3+a` / `1.2.3+b`）semver 优先级相等，`maxVersion` 用 `semver.gt` 比较时两个方向都是
  `false`，`latest_*` 落到 `candidates.find(...)` 的**行序首个命中**，并列裁决**未定义**（已知
  缺陷，不是设计；2026-10-26 记录，是否改代码未定）。`v` 前缀不 strip、直接拒。

**Q5 下载 token → 30 分钟、多用途、绑 sha256；不承诺单次；插件走 JSON 签发。**

- 不变量 `token_ttl > intent_ttl + fetch_timeout + skew`（30 > 15 + 0.025 + 偏移）。
- 复核条件：资产存在、未 yank、摘要一致、版本/产品 published、上游非 disconnected；**不要求是
  最新版本** —— 否则发布与安装互斥失败，core 记 `download_failed` 且无法重签。
- `POST /api/v1/download-urls` 给插件，`GET .../download/{os}/{arch}` 给浏览器，共用一个签发
  函数。
- 代价：URL 在 30 分钟内可被转发复用，靠 yank/断开立即 410 + 限流兜。放弃单次 + 改契约（core
  要认识商城，问题只换位置）、nonce 表（v1 多一张表 + GC）。

**Q6 宿主版本暴露（追加）→ `host.api` Ping 加 `coreVersion` + `buildVersion`；目录按约束过滤。**

- `coreVersion` = `CoreCompatibilityVersion()`（契约要求严格 semver；该函数对非 dev 值不校验，
  商城自验），`buildVersion` = `version.Get().Version`（`dev` / `dev-abc12`），只用于 dev 识别
  与排障。
- 选 Ping 而非 env / 新命令：插件已有 `host.api` 客户端与 capability，加字段向后兼容；旧宿主
  缺字段时按 unknown 处理。
- 过滤：已知版本默认仅兼容、可切全部；未知/非法不过滤 + 未校验徽标；dev 构建标「按开发版
  估算」；约束求值取代等值比较（关闭 A7）。
- **2026-10-26 指针（不改上面这条结论）**：dev 的 `coreVersion` 已由 `apps/api/version` 从
  git tag 派生，所以 dev 的判定基准是「宿主派生版本」，不再是固定 `1.0.0` —— 只有没报
  `sforum` 的老宿主才回落 `1.0.0`。同时 dev 构建默认 `compat=all`（不再默认过滤），预发布
  core 的求值按 core 的 `releaseBase` 对齐。现行口径以 §7.3.8 为准。
- 代价：SForum 侧要改 host API 契约与文档，并推翻伴生计划 D9；商城多一个 ETag 维度。
- 放弃：只暴露 `Current`（dev 字符串不能用于约束匹配）；env（只对新进程生效）；新命令
  `sforum.host.info@1`（命令目录、权限、契约、测试全要加，最重）。

### 10.3 下一轮议题（原阻塞项 6–8）

- 产品页信息架构：截图数量/尺寸、分类法、排序、搜索、中英双语字段粒度。
- 插件页 UX 状态机：列表/详情/安装/更新/错误，无权限与 stale 缓存的文案。
- 运维：Bun 回退 Node 的判定标准、自部署 GitHub App 的 10 分钟步骤、备份/迁移。

### 10.4 移交 SForum 的观察（本轮只读，不改 SForum）

1. **重试与状态机冲突**：伴生计划 §6.6 第 1 步「非 `pending` 直接成功返回」与「网络错误交给
   River 重试」矛盾 —— 首次失败后意图已是 `running`，重试会被短路成成功，意图永久停在
   `running`，插件轮询 2 分钟后只能报超时。建议：终态（`staged|failed|expired`）短路；
   `running` 允许重入，或重试前条件重置回 `pending`。
2. **`MaxAttempts: 3` 的措辞**：是共 3 次尝试（2 次重试），不是「3 次重试」。
3. **`AGENTS.md`「分发」节**：现行「下发时复核仍是当前发布版本且未 yank」与 Q5 裁决冲突；该
   文件不在本轮可改范围，随计划批准一并改。
4. **应用版本暴露（Q6）**：伴生计划 D9「暂不做 `hostVersion`」需改；`app/Support/Marketplace/**`
   删除后没有任何 `HostSForumVersion` 面。建议在 `host.api` `Ping` 的 `data` 里加
   `coreVersion = version.CoreCompatibilityVersion()` 与 `buildVersion = version.Get().Version`。
   注意 `CoreCompatibilityVersion()` 对非 dev 值不校验 semver，消费方（商城）必须自己验。

## 11. 阶段推进中的未决项

状态标注：**已关闭** / **部分** / **开放** / **阻塞（外部）**。收尾轮 2026-10-24 的复核证据见
`sessions/2026-10-24-s7-provider-contract-and-optional-items.md`。

1. §7 S4 的可判定验收细则（A9）——**已关闭**（§7.4 已写，S4 通过）。
2. 数据保留与账号删除口径（论坛 token、审计日志、上传图片）——**开放**。
3. vendored manifest schema 的来源钉法（SForum tag vs commit vs main）——**开放**；当前以宿主
   自带 `extension validate` 作为权威闸门。
4. SForum 侧 hostVersion 暴露落地（Q6）——**阻塞（外部）**：检出里没有任何 `coreVersion`
   暴露面（`grep -rn coreVersion apps/api/app` 只命中内部 `CoreCompatibilityVersion()` 用法），
   商城因此继续按 `compatibility=unknown` 不过滤。
5. **浏览器下载入口只签最新 stable**（S3）——**开放**：契约
   `GET /products/{slug}/download/{os}/{arch}` 没有版本路径，UI 对非最新版本置灰；插件走
   `POST /v1/download-urls`（带 `version`）不受影响。
6. 真实 SForum provider 登录与真实 GitHub App——**部分**：
   - provider 侧已用只读探针核对并修正两处契约漂移（JSON 请求体、camelCase userinfo），
     修复后 `token`/`refresh`/`revoke` 返回标准 OAuth 错误而非 422；
   - 仍缺「完整登录」的两个前提：论坛后台登记的 client secret（库里只有 `secret_hash`）与
     一个已登录的论坛用户会话——本轮没有写论坛库；
   - 真实 GitHub App（私有仓库、webhook 重放、302 跟随）仍未跑，需要真实 App 凭据。
7. rename 后的展示名在批准前已对外可见（S4 决策第 3 条）——**开放**（刻意取舍）。
   ~~审核页 GitHub Actions 提示未实现~~——**已关闭**（§7.4 第 25 条已补）。
   ~~仪表盘列表 N+1~~——**已关闭**（单条聚合 + `latestVersion` 下沉到 `lib/products`；
   整页 SQL 固定 3 条）。
8. **真实宿主端到端未跑**（§7.5 第 19 条）——**阻塞（环境）**：需要在 SForum 里装配插件包并点
   一次 `bridge.installExtension` 停在 `staged`。两处硬边界：宿主客户端只接受 `https:` URL
   （不通过即 `install_invalid_request`，请求都不发）；服务端下载器在
   `apps/api/bootstrap/api_assembly_domains.go:452` 装配时**不传** `AllowHTTP/AllowPrivate`，
   因此只取公网 HTTPS。本机没有公网可达的 HTTPS 源。
9. 插件的「已装/更新检查」——**阻塞（外部）**：`AdminMicroFrontendBridgeV1` 只有
   `request/toast/t/navigate/settings/icons/installExtension`，没有已装清单读取面，而页面按 S5
   决策只访问插件自身后端。~~i18n 只做了 zh-CN~~——**已关闭**（管理页 zh-CN + en-US）。
10. **插件包的真实宿主装配已验证到「启用 + 后端启动 + 路由注册」**（§7.6 第 14 条）；
    仍未验证的是**带登录会话的浏览器点击**与 `install-from-url` 的真实 HTTP 跳转。复现步骤见
    `sessions/archive/2026-10/2026-10-24-s6-hardening.md`（真实宿主装配一节）。
11. **OAuth 请求体契约**——**已关闭**：provider 路由是 `application/json` +
    `additionalProperties:false`；`client_id` 8..128 已在启动时校验（`ConfigError`），不再等到
    登录时才 422。参见 `decisions/2026-10-24-oauth-fake-mirrors-route-contract.md`。

**这些项随阶段关闭，不阻塞已批准的 S0/S1。**
