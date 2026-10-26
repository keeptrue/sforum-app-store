# Agent Guide

本文件是 `sforum-app-store` 的共享工作约定。开始任何会话前先读它，再读
`knowledge/index.md` 与当前任务书。这里的规定优先于个人默认习惯。

## Project Intent

SForum 应用商城：一个**独立服务端**加一个 **SForum 插件**，让不同 SForum 站点能浏览、
发现、安装插件与主题。商城不进入任何论坛实例的请求链路，它是 SForum 之外的一个产品。

一个仓库两个产物：

- `service/` —— 商城服务端。Next.js（App Router）+ Bun + PostgreSQL。
- `plugin/` —— SForum 扩展 `sforum.store`。Go 后端 + 手写预构建 ESM 管理页（无 Vue/Vite，见 S5 决策）。
- `contracts/` —— 两者共享的 OpenAPI 契约，生成各自的 client/类型。

服务端独立存在的理由：它服务多个论坛、有独立生命周期与故障域、要处理不可信开发者输入
与 GitHub 出站流量。把它塞进某个论坛会让目录可用性、权限面和发布节奏被单站点绑死。

## 不得违反的边界

1. **两条身份线，互不授予。**
   - **论坛身份**（开发者、审核员）只来自 SForum 的 OAuth2 提供方；无动态客户端注册，
     `client_id` 只能在论坛后台手工创建。issuer 由**后台配置**（`oauth_issuers` 表），
     不再读 env。
   - **管理员**是商城本地账号（`admin_accounts`，用户名 + 密码），不来自任何论坛，也拿不到
     论坛 token。OAuth 账号永远不是管理员。
   - 首个管理员只能凭一次性 `STORE_ADMIN_SETUP_TOKEN` 注册；未配置时注册入口关闭。
     理由与取舍见 `knowledge/decisions/2026-10-25-admin-local-identity.md`。
2. **不存 PAT。** 仓库访问只经 GitHub App installation token。
3. **不存包体。** ZIP 只落临时文件，检测完即删；不写对象存储、不做 CDN 回源缓存。
   README、`brand/icon.png` 与 `brand/social-preview.png` 例外：它们落内容寻址的 `assets`，
   因为它们是展示内容而不是安装包。
4. **不暴露上游地址。** 目录只发商城签名短链；GitHub 的 `browser_download_url` 永不出现在
   任何响应里。
5. **不代劳启用/信任。** 安装只经宿主的页面动作把包交给 core：`bridge.installExtension` 只暂存，
   `bridge.installAndEnableExtension` 由**宿主**按自己的规则启用（可执行后端的包仍要 super_admin 的
   一次性信任确认，非超管/主题包停在 `staged`）。商城不 enable、不 trust、不 upgrade，也不自己判定
   信任；页面只转述宿主回报的 `outcome`。
6. **商城不写论坛数据库、不调论坛内部接口。** 与论坛的唯一面是 OAuth2 登录端点、userinfo，
   以及插件管理页调用宿主的 `bridge.installExtension` / `bridge.installAndEnableExtension` 页面动作。
7. **商城角色不来自论坛用户组。** `moderator` 由本仓 `store_roles` 决定；`admin` 是
   `admin_accounts` 里的本地账号，`store_roles.role='admin'` 已废弃（旧行保留但不参与鉴权）。
8. **产品身份只来自 GitHub。** 创建只能经「从 GitHub 导入」（release 里的清单）；名称取自清单，
   介绍取自 README，图标取自仓库的 `brand/icon.png`（缺失才回退 GitHub 社交预览），分享卡取自
   `brand/social-preview.png`。没有手填产品、没有上传图片、没有第二份长文案。
   取舍见 `knowledge/decisions/2026-10-25-github-only-product-identity.md` 与
   `knowledge/decisions/2026-10-25-brand-assets-from-repo.md`。

## Stack And Directory Map

- `service/` —— Next.js App Router + TypeScript + Tailwind；Bun 作为包管理器与运行时。
  - 目标布局：`src/app/`（公开前台 / dashboard / moderation）、`src/app/api/v1/`、`src/lib/`
    （oauth client、github app、detection、storage、readme 渲染）、`src/worker.ts`（pg-boss）。
  - PostgreSQL 16 + Drizzle ORM + drizzle-kit；队列用 pg-boss，独立 worker 进程、同镜像。
  - 图片：`file-type` 验魔数 + `image-size` 读尺寸，内容寻址存储；**不引入 `sharp`**。
  - README：`markdown-it` + `sanitize-html` 渲染成 HTML（`lib/readme/`），HTML 是唯一对外表示。
- `plugin/` —— 仓库根即 SForum 的 `EXTERNAL_EXTENSION_ROOTS` 源根，扩展包在
  `plugin/plugins/sforum.store/`。
  - Go 后端 `require github.com/keeptrue/sforum/apps/api v0.0.0` + 本地 `replace`；
    CI 用 `go mod edit -replace` 指向 SForum 检出。
    **这个模块路径随上游一起翻了**（`zhuchunshu` → `keeptrue`，上游 `e753c72b0` 改的
    `apps/api/go.mod:1`）：写 `keeptrue` 才是对的，见到 `github.com/zhuchunshu/sforum/apps/api`
    一律按漏改处理 —— 它必须与 `ci.yml` 的 SForum checkout `ref` 同批移动。
    `*.lock.json` 的 `upstream` 不要手改，走 `bun run capabilities:sync` / `manifest:sync`。
    两波经过与判据见 `knowledge/decisions/2026-10-26-github-account-rename.md`。
  - 管理页是**预构建** ESM/CSS（Admin Micro-frontend API v1），构建产物进包，源码不进运行时。
- `contracts/store-api.yaml` —— 唯一跨产物契约。
- `knowledge/` —— 项目记忆。`plans/` 任务书、`decisions/` 决策记录、`sessions/` 热交接。
- `docs/` —— 部署、开发者接入、GitHub App 注册步骤。

## Commands

**S0–S6 已落地。**

```bash
bun install
bun run dev                 # 等价于 bun run --filter service dev
bun run build               # 等价于 bun run --filter service build（bun --bun next build）
bun run contract:generate   # OpenAPI → service/src/lib/api-types.ts
bun run manifest:check      # vendored 清单 schema 与 lock 摘要一致
bun run manifest:conformance # 商城解析器跑一致性夹具（加 --host 时与宿主校验器对拍，见下）
bun run capabilities:check  # vendored 宿主能力目录与 lock 摘要一致（CI 跑这条）
bun run capabilities:sync -- --sforum <SForum 检出>  # 从宿主生成物重取能力目录
bun run test                # bun test（unit + Postgres 集成）
bun run typecheck           # tsc --noEmit（用 tsconfig.check.json，不依赖 .next 生成类型）
bun run db:migrate          # 需要 service/.env.local
bun run seed:dev            # 本地预览数据（幂等；生产不用，构建不 import）
bun run worker              # pg-boss worker（同镜像）
bun run admin:reset-password -- <username>   # 管理员密码重置（--generate / --password-stdin / --list）

# 插件（Go + 预构建 ESM；构建脚本在 plugin/scripts）
bash plugin/scripts/build.sh          # Go 构建 → 管理页打包 → 摘要 → 清单校验
bun test plugin/plugins/sforum.store/frontend/admin/src
cd plugin/plugins/sforum.store/backend && go vet ./... && go test ./...
```

`bun --bun next build` 的冒烟是 `/api/health` + 一页 SSR。`next start` 只作为 Bun 原生依赖
失败时的回退，构建与脚本保持 Bun。`tmp/` 是本地草稿目录，不入库。

网络依赖命令前按需设置本地代理（与 SForum 仓一致）：
`export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897`

## 运行时闸门

Bun 跑 Next.js 生产运行时是**待验证项**，不是信仰。CI 必须跑一次 `bun --bun next build` +
启动冒烟（`/api/health` + 一页 SSR）。若原生依赖失败，**只允许 `next start` 回退 Node**，
构建与脚本保持 Bun。回退判定以 CI 证据为准，不接受「应该能跑」。

本地已验证（2026-10-24）：`bun --bun next build` + `bun --bun next start` + `/api/health`
通过；CI 首次 push 后以 CI 证据为准。

**dev 不走同一条路（2026-10-25 实测）。** Turbopack dev 把 `serverExternalPackages`（Next
默认表就含 `postcss`、`pg`）的引用改写成带哈希的别名 `require("<pkg>-<hash>")`，解析靠
`.next/dev/node_modules/<pkg>-<hash>` 软链；Bun 会把「第一次没找到」缓存到进程生命周期，Node
不缓存。于是 Bun 跑 dev 时首次编译的写入竞态（chunk 早于软链约 5 ms）会让整个进程**永久**
500（`/p/[slug]` 卡在 `sanitize-html → postcss`，`/api/health` 卡在 `pg`），只有换进程能恢复，
`rm -rf .next` 后必现。所以 `dev` 跑 Node（`"dev": "next dev -p 4000"`，`bun run` 不带 `--bun`
执行的就是 Node），build/start 仍按上面的 Bun 证据走。理由与重开条件见
`knowledge/decisions/2026-10-25-dev-runtime-node.md`。

## 身份与会话（实测约束，照抄）

这些来自 `sforum-oauth2-provider` 的实现与实测，不是可选优化：

- 端点：`/api/oauth/{authorize,consent,token,userinfo,revoke,introspect,csrf}`。
- **所有插件路由都在宿主 CSRF 中间件后**。服务端换 token / refresh / revoke 必须：
  `GET /api/oauth/csrf` 拿 `csrf_` cookie → 再带 `X-Csrf-Token` 与 `Origin: <forum>` 发 POST。
  标准 OAuth 库直接接会 403。
- **请求体是 JSON，不是表单**（2026-10-24 对真实 provider 复核）：token/revoke 路由的
  `x-sforum-request-schema` 声明 `application/json` + `additionalProperties: false`，宿主在
  handler 之前按 schema 校验；`application/x-www-form-urlencoded` 会被
  **422 `extensions.route_schema_invalid`** 拒掉（不是 400 invalid_request）。字段长度也有
  schema 约束：`code_verifier` 43..128、`client_id` 8..128 —— 空值要省略，不能发空串。
- **客户端凭据只能放 JSON 请求体**：Host 以 filtered authority 交付，`Authorization` 头到不了
  插件路由。不要用 HTTP Basic。
- **userinfo 只认 `access_token` 查询参数**，不读 `Authorization`；响应字段是 **camelCase**：
  `sub`(string) / `username` / `displayName` / `avatar` / `email` + `emailVerified`，没有
  `name`/`avatar_url`/`email_verified`。错误体在 token 用 `error_description`、在 revoke 用
  `errorDescription`。
- 授权码必须带 PKCE（S256，base64url 无填充）；回调地址精确匹配，生产要求 `https`，本地
  允许 `http://127.0.0.1` / `http://localhost`。
- `sub` 只在单个 issuer 内稳定。账号唯一键必须是 `(issuer_key, sub)`，永远不要用
  `username`。`issuer_key` 是运营方指定的稳定标识，永不复用、永不改名；URL 只是配置。
- `client_secret` 轮换是**单哈希覆盖**，没有双 secret 宽限；但 refresh token 绑 `client_id`
  不绑 secret，所以轮换不需要让用户重新登录。轮换步骤：论坛后台 rotate → 更新配置 → 滚动重启。
- scope 有内建回退：请求不带 `scope` 时服务端用应用登记的默认集合。`profile` 恒授予。
- 商城会话用 `__Host-store_session`（HttpOnly / Secure / SameSite=Lax），PG 持久化，支持撤销
  其它设备；会话轮换在登录成功时进行。

## 管理员后台（2026-10-25 落地）

- 入口路径由 `STORE_ADMIN_PATH` 决定（默认 `admin`，单段）。实现是顶层动态段
  `app/[adminPath]/`：`layout.tsx` 比对配置，不符即 `notFound()`。**改 env 重启即生效，
  不重建镜像**（静态路由优先于动态段，`/dashboard`、`/moderation`、`/api/*` 不受影响）。
- **可配置路径是混淆，不是防护。** 真正的边界是 `admin_sessions` 会话 + 账号存在性检查；
  不要因为路径藏起来就放松鉴权。
- 密码：`node:crypto` scrypt（`scrypt$N$r$p$salt$hash` 自描述），不用 `Bun.password`
  （`next start` 回退 Node 时不存在）。12–200 字符；失败 5 次锁 15 分钟。
- 会话：`__Host-store_admin_session`，绝对 8 小时不滑动，与论坛会话**完全独立**，不可互换。
- 授权：页面用 `getAdminSession`（未登录跳登录、需改密跳改密页），API 用
  `authorizeAdminRequest`（写操作先同源检查，再 401/403）。越权一律 404（页面）。
- 写操作必须 `recordAudit(..., { actorAdminId })`；`audit_log.actor_admin_id` 是管理员专用列。
- 「最后一个启用的管理员」不可禁用（`last_admin`），否则后台无人可进。
- 首个管理员只能凭 `STORE_ADMIN_SETUP_TOKEN` 注册；无管理员时 `/setup` 才存在，初始化后
  一律 404。未配置 token 时注册入口关闭并在页面给出生成命令。

## GitHub App

- **配置只在后台**（`github_app_config` + `github_app_private_keys`，`/[adminPath]/settings/github`），
  不读 env：`GITHUB_APP_ID` / `GITHUB_APP_SLUG` / `GITHUB_WEBHOOK_SECRET` /
  `GITHUB_APP_PRIVATE_KEYS` / `GITHUB_API_BASE_URL` 已于 2026-10-25 移除。留在 env 的只有
  `STORE_SECRET_KEYS`——它是加密根，不是表单能填的配置。webhook secret 与私钥用 keyring 加密存
  库，界面只显示「有没有配」与公钥指纹；`lib/github/app-config.ts` 是唯一读写口。
- **新部署走「一键创建」**（GitHub App Manifest flow，`lib/github/manifest.ts` +
  `POST /api/admin/github-app/manifest/start` + `GET /api/github/manifest/callback`）：权限、事件、
  三个地址与 `public: true` 写进代码，`id`/`slug`/`pem`/`webhook_secret` 由 GitHub 交回。它只能
  **新建** App，所以是替换语义（删旧行 → 旧私钥随级联消失 → 按首次保存写入）。state 绑管理员会话，
  因为 conversions 端点不认证、code 即凭据。手动表单只给 GHES 与接管已有 App。
- 权限：`Contents: read` + `Metadata: read` + `Actions: read`；不申请 `Administration`。
  `Actions: read` 只用于审核页展示 release 所指 commit 的 workflow run，不作自动发布闸门，
  界面不写「已验证构建」。
- 事件订阅：**要订** `release`、`repository`、`push`（少订 `repository` 会让仓库改名/转移/转私有
  静默失效；少订 `push` 只影响品牌图实时性，退化为「发版 + 每日巡检 + 手动」）；
  `installation` / `installation_repositories` 是恒定投递，**不要**写进 manifest —— GitHub 会以
  `Default events unsupported` 拒掉整份 manifest，但照样投递这两个事件。
- `push` 是最吵的事件：`/api/github/webhook` 在**写 `webhook_deliveries` 之前**用
  `lib/github/push-filter.ts` 过滤（默认分支 + 命中 `(^|/)brand/`），否则每个仓库每次 push 都会
  存一份 payload。已安装的 App 不会自动获得新事件，升级后要在 App 设置页补勾。
- App JWT ≤10 分钟；installation token 每小时换，缓存到过期前 60 秒。私钥支持多把以便轮换：
  轮换是「先加后删」，最新一把签名（`GithubAppClient` 取最后一把），最后一把不可删——没有签名
  私钥就签不出 JWT，后台自己的「验证」按钮也救不回来。
- 后台保存即失效进程内缓存（15 s TTL 只用于省掉每请求一次的读库与解密）；配置读不出来
  （keyring 缺 kid）报 `github_config_unreadable`，**不要**当成「未配置」静默关掉 webhook。
- Webhook 必须验 `X-Hub-Signature-256`，按 `X-GitHub-Delivery` 幂等；事件处理只入队，不在
  请求内做重活。
- 仓库身份用 `repo_id`，`full_name` 只是显示字段。

## 仓库绑定与待认领

取舍见 `knowledge/decisions/2026-10-25-github-repo-binding.md`。

- **sync 不建产品、不补 `repo_id`、不跨仓库写版本。** manifest id 解析成四种判定，只有
  「产品存在且 `repo_id` 等于来源仓库」才写版本；其余分别记 `product_unclaimed` /
  `repo_bind_pending` / `repo_mismatch`。未认领的 id 写进 `repo_claims`，不落 `products`。
- **绑定只能经 `/api/dashboard/products/[id]/repo`。** `parseProductPatch` 的
  `NON_EDITABLE_FIELDS` 已经封死 PATCH 改 `repo_id`；不要为省事在 PATCH 里开口子。
- **绑定前必须过 `findBindableRepo`。** 它同时检查「仓库存在」「installation 属于当前账号」
  「installation 是 `active`」「上游未 disconnected」；任一不满足按 404 处理，不返回 403。
- **`repo_bound_via` 只有两级**：`installation`（弱，v1 唯一可得的）与 `github_identity`
  （阶段 2）。界面与审核台按这一列措辞，`installation` 一律不写「已验证」。
- **仓库列表读本地 `github_repos` 镜像**，打开选择器不打 GitHub；「从 GitHub 同步」是显式动作，
  走 `repo` 限流通道。`/installation/repositories` 必须分页（100/页，最多 10 页），超出预算
  报 `installation_repo_limit`，不静默截断。
- **已发布产品不可解绑**（409 `repo_binding_locked`），换绑允许并自动进重新审核
  （`repo_changed` 分支已覆盖，不改策略）。
- **导入从 manifest 取身份**：`POST /api/dashboard/products/import` 读最新 release 的 ZIP 清单，
  用 `id`/`name`/`type` 建产品，并立刻同步同一个 release（webhook 在那之前已经跑过）。
  ZIP 只落临时目录，`cleanup()` 放 `finally`。
- **认领重新读 release**，不相信 claim 里存的清单名与 tag；认领后 `markClaimed` 只在
  `state='pending'` 时成功，第二次返回冲突而不是建第二个产品。

## 检测与版本

- 平台判定顺序：`debug/buildinfo` → ELF/Mach-O 头 → 文件名；每次兜底写 `detection_source`。
  主题没有后端二进制 → `any/any`。
- 版本以**清单**为准（`sforum.extension.json` 的 `version`），release tag 只是标签。
- 清单里的 `sforumVersion` 是 **semver 约束**（Masterminds 语义），不是版本号；按等值比较
  一定是错的。
- 一个 ZIP 只含一个扩展：解析入口只会返回单个清单。多扩展仓库 = 一个 tag 挂 N 个 ZIP。
- 摘要一律流式 SHA-256；release 若带 `checksums.txt`/`SHA256SUMS` 必须交叉校验。

## 清单契约（2026-10-25）

- **结构权威是宿主的 JSON Schema**：`service/src/lib/detection/schema/manifest-v3.schema.json`
  是 `apps/api/app/Support/ExtensionManifest/schemas/manifest-v3.schema.json` 的逐字节副本，
  `manifest-v3.lock.json` 钉 commit + sha256。**不要手改 schema**；改契约只走
  `cd service && bun run manifest:sync -- --sforum <SForum 检出>`，`manifest:check` 守摘要。
- **只补语义差量**：id/version/type、必填与 URL、backend 四元组、主题禁声明、`requiresFeatures`、
  `packageFiles` 摘要。宿主 13.5k 行 V3 语义校验器（routes/hooks/database…）不搬。
- **归档边界照 `ReadArchive`**：清单必须在 ZIP 根、4096 条目、拒绝 symlink / 重复条目 / 含 `..`
  的路径。理由：商城不能上架宿主装不上的包。
- **`sforumVersion` 按 Masterminds 求值**（`,` 与 `!=`）；`catalog/compat.ts` 只做 host 版本口径，
  解析在 `lib/semver-constraint.ts`。
- **清单元数据落库展示**（`release_versions.manifest_*`），但不改变「产品身份只来自 GitHub」：
  README 仍是唯一长文，`author.email` 校验后丢弃。
- 新增/修改规则必须同时改 `service/test/fixtures/manifest` 的夹具，并让
  `bun run manifest:conformance --host` 通过。

## 分发

- 下载短链携带：asset id、sha256、exp；服务端在下发时复核「资产存在、未 yank、摘要一致、
  版本/产品 published、上游非 disconnected」。**不要求「当前最新版本」**，否则发布与安装会互斥
  失败；yank 或断开立即 410。
- **例外（2026-10-25）**：分发形态为 `redirect` 且仓库公开时，`/api/v1/download/{token}`
  以 `302` 把 GitHub 已签好的对象地址交给客户端（商城不再承担带宽），复核仍在上一条的五项上生效，
  但**已发出的 302 无法撤销**。私有仓库永远走代理——对象地址里带着仓库名与 tag。默认 `proxy`。
  这个值是**运行时设置**：`store_settings.download_mode` > `STORE_DOWNLOAD_MODE` 种子，后台
  「系统设置 → 下载分发」可改，留空即跟随环境变量。见
  `knowledge/decisions/2026-10-25-download-redirect-mode.md`。
- 响应头：`Content-Type: application/zip`、`Content-Length`、`Content-Disposition: attachment`、
  `X-Content-Type-Options: nosniff`、`Cache-Control: private, no-store`。
- TTL 与 SForum 安装意图的过期时间必须兼容（见任务书 §10 Q5）；不要把「单次」写进文档除非
  它真的可执行。

## 安装交接（2026-10-24 契约变更，以 SForum 落地实现为准）

SForum 已删除商城预留代码，并在 `10c2b21e8` 落地**页面级宿主动作**，同时否决了
`extensions.install` 能力 + 命令 + 意图表 + worker 的旧设计
（SForum `knowledge/decisions/2026-10-24-admin-page-host-action.md`）。

- 清单在 `view: "component"` 的管理页上声明 `hostActions: ["extension.install"]`；不在
  `capabilities` 里声明安装能力（该能力不存在）。
- 管理页调 `bridge.installExtension({url, sha256, expectedExtensionId, expectedType,
  expectedVersion?})`；必须先 `typeof bridge.installExtension === "function"` 特性检测，旧宿主
  上降级为「复制签名链接」。
- 宿主做权限预检 + 自己的确认框 + 一次同步 `POST /admin/extensions/install-from-url`
  （120 s 预算），解析清单后比对 `expectedExtensionId/Type/Version`，不符报
  `extension.expected_mismatch`。
- 成功语义是**已暂存**：文案「已暂存，去完成信任/升级」，**不能**写「已安装」「已更新」
  「已验证构建」。启用/信任在 core 页面完成。
- v1 同步：导航离开即取消（`install_cancelled`），页面必须写「安装期间不要关闭页面」；
  不做后台静默安装、不做自动升级、不做队列/worker。

## 数据与身份规则

- 账号：`(issuer_key, sub)` 唯一；产品归属 `owner_account_id`。
- `extension_id` 跨仓库全局唯一；冲突由审核裁决，不做先到先得。
- 产品生命周期与上游连通性**分开表达**（详见任务书 §10 Q2）：不要把所有状态塞进一个 enum。
- 每个新权限键都要同时更新种子、展示文案、契约与知识库；前后端都要有 allowed/denied 测试。
- 越权一律按 404 处理，不泄漏资源存在性。

## 后端与前端约定

- 路由处理只做解码/编码与传输；业务在领域服务；SQL 在 store。不要在一个函数里混合 SQL、
  解析、策略与响应格式化。
- 单文件 500 行是复查信号，1000 行是硬警告；按职责拆分，不按行数硬切。
- 页面路由保持壳：元数据、查询状态、SSR 编排、组合。大块表单/表格/检查器放特性组件。
- UI 统一 shadcn/ui **Nova** 风格（紧凑密度）：组件源码放 `service/src/components/ui`，按需
  复制与修改，不引黑盒组件包。图标只用 Lucide；动画只用 Motion；分栏用
  react-resizable-panels；拖拽用 dnd-kit；客户端状态用 Zustand。同一能力只保留一个库，新增
  依赖先写 `decisions/`。
- 设计 token 走 `service/src/app/globals.css` 的 CSS 变量；页面不写死颜色。
- **三个面共用一个外壳**：`components/shell/app-shell.tsx`（248px 轨 + 顶栏 + 移动端 Sheet）。
  前台、开发者门户、管理员后台只传入各自的 `nav`/`railFooter`/顶栏插槽，不复制布局。
  侧栏链接统一走 `SidebarNav`（presentational，`active` 由各面自己算）。
- **共享展示组件在 `components/common/`**：`PageHeader`、`Section`、`Stat`/`StatGrid`、
  `EmptyState`、`Field`/`FormError`、`SubmitButton`、`Modal`、`ConfirmDialog`。
  新页面直接组合它们；不要手写 `rounded-* border border-border bg-card`（用 `.surface` /
  `.surface-quiet` / `.surface-dashed` 工具类），也不要自己拼标题排版（用 `.page-title` /
  `.page-lede` / `.eyebrow` / `.section-title`）。
- **主题是三态**：`light | dark | system`，存 `localStorage["store-theme"]`，预绘制脚本
  `THEME_BOOTSTRAP`（`components/theme/theme.ts`）与 `ThemeToggle` 共用同一份常量；切换控件
  由 `AppShell` 顶栏统一渲染，前台与后台都有。改主题语义只改 `theme.ts`。
- 图标只用图标库（Tabler / Lucide）。**不用 emoji 当图标、状态标记或装饰**。
- 不手绘内联 SVG 图标。插件管理页走 `@sforum/admin-sdk@1` 时用 `SPluginIcon` / `bridge.icons`
  解析器；手写 ESM 拿不到 Host 图标运行时，按钮就用文字。
- i18n：UI 默认 `zh-CN`，其次 `en-US`；产品文案走 `product_translations`，回退默认语言。
- 后台页面改动要有 1633×810 与 390×844 的渲染证据（对齐、溢出、可访问名称），源码与单测不算
  视觉验收。
- 成功动作给 Toast；阻塞错误留在表单旁，错误 Toast 不自动消失。

## 安全

- 出站白名单：GitHub API（含读 `brand/` 的 Contents 接口）、`github.com`（只抓仓库页 HTML 取
  `og:image`）、`repository-images.githubusercontent.com`（只抓预览图）、对象存储。抓取 URL 由库里的
  `repo.full_name` 与两个固定常量路径构造，不接受用户提交的抓取地址，因此不需要通用 SSRF 抓取器。
- 品牌资产只读固定文件名 `brand/icon.png` 与 `brand/social-preview.png`；**目录**是包目录
  （与 `sforum.extension.json` 同级，可能在 `plugins/<name>/` 下），由 `locateBrandDir` 用清单位置
  与 `id` 定位，最多列一次仓库树、最多读 5 个清单，定位不出就退回仓库根、不猜。
- 图片准入：PNG/JPEG/WebP，魔数 + 尺寸校验，**禁 SVG**，内容寻址存储。品牌图标另加「方形 + ≤1 MiB」，
  分享卡另加「2:1（±5%）+ ≤1 MiB」。
- README 在服务端渲染后过白名单（`lib/readme/render.ts`）：禁 `script`/`style`/`on*`/`iframe`，
  图片 https-only，外链 `nofollow noopener noreferrer ugc`。不信任开发者 HTML。
- README 图片**不代理**：相对路径重写为 `raw.githubusercontent.com`，`http:` 图降级为文字链接。
  代价是访客 IP 交给 GitHub；这是记录在案的取舍。
- 登录、提交、下载、恢复仓库各有独立限流；管理动作写审计。
- 私钥、`client_secret` 用 `STORE_SECRET_KEYS` 加密后存库（GitHub App 私钥与 webhook secret 在
  `github_app_private_keys` / `github_app_config`，issuer secret 在 `oauth_issuers`）；keyring 本身
  只从环境/密钥管理读取。任何明文都不进日志、不进响应、不进审计 details。

## 测试

- 单测 + PostgreSQL 集成测试；worker 用真实 PG 跑，不用内存假队列替代核心路径。
- OAuth 的 CSRF/cookie 形状必须有覆盖：真实 provider 或高保真 fake，并在计划里写明选了哪个。
- Webhook：签名通过/失败、重放、乱序三类用例。
- 检测：公开/私有 fixture 各一条 release，含主题（无后端）与多扩展 tag。
- 权限：每个受保护路由都要 allowed + denied 用例。

## 知识库工作流

开工：`knowledge/index.md` → 相关 `modules/` 或 `plans/` → 热 `sessions/`。
收工：更新任务书状态（仅人工批准后）、写一份新的热交接、把过时交接移入
`sessions/archive/YYYY-MM/`、架构级取舍写 `decisions/`。

计划状态词汇与 SForum 一致：`draft | ready | active | blocked | blueprint | completed |
cancelled | superseded`。**`draft` 期间不实施。**

## 未验证就写「未验证」

不确定的接口、行为、限制，写「未验证」并说明验证方式。不要用看似合理的描述填空。任何
「应该」「大概」「通常」都要换成证据或标注。

## 当前状态

见 `knowledge/index.md`。S0–S6：`service/` 骨架、契约、CI、Postgres/Drizzle、OAuth2
登录/会话、GitHub App、webhook/worker、release 同步/检测、DB 驱动的目录/详情、公开 `/api/v1`、
签名下载代理、产品 CRUD 与内容寻址图片、审核流与开发者门户/审核台，以及插件
`plugin/plugins/sforum.store/`（清单 + Go 后端代理 + 预构建 ESM 管理页，宿主 validate/test/
package 全绿）、限流与认证审计、运维文档（deployment/plugin/developer）与回滚演练已落地；
插件包已在真实宿主上完成装配/暂存/启用/后端启动/路由注册；仅剩带登录会话的浏览器点击与
`install-from-url` 的公网 HTTPS 跳转未验证。`tmp/` 下是本地设计草稿，不入库。
