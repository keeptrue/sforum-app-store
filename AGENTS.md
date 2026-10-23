# Agent Guide

本文件是 `sforum-app-store` 的共享工作约定。开始任何会话前先读它，再读
`knowledge/index.md` 与当前任务书。这里的规定优先于个人默认习惯。

## Project Intent

SForum 应用商城：一个**独立服务端**加一个 **SForum 插件**，让不同 SForum 站点能浏览、
发现、安装插件与主题。商城不进入任何论坛实例的请求链路，它是 SForum 之外的一个产品。

一个仓库两个产物：

- `service/` —— 商城服务端。Next.js（App Router）+ Bun + PostgreSQL。
- `plugin/` —— SForum 扩展 `sforum.store`。Go 后端 + 预构建 Vue 管理页。
- `contracts/` —— 两者共享的 OpenAPI 契约，生成各自的 client/类型。

服务端独立存在的理由：它服务多个论坛、有独立生命周期与故障域、要处理不可信开发者输入
与 GitHub 出站流量。把它塞进某个论坛会让目录可用性、权限面和发布节奏被单站点绑死。

## 不得违反的边界

1. **无注册、无密码、无动态客户端注册。** 身份只来自 SForum 的 OAuth2 提供方；`client_id`
   只能在论坛后台手工创建，商城对 issuer 必须配置驱动。
2. **不存 PAT。** 仓库访问只经 GitHub App installation token。
3. **不存包体。** ZIP 只落临时文件，检测完即删；不写对象存储、不做 CDN 回源缓存。
4. **不暴露上游地址。** 目录只发商城签名短链；GitHub 的 `browser_download_url` 永不出现在
   任何响应里。
5. **不代劳启用/信任。** 安装只投递 SForum core 的安装意图，最终 `staged` 即止；启用、信任、
   激活一律由论坛管理员在 core 页面完成。
6. **商城不写论坛数据库、不调论坛内部接口。** 与论坛的唯一面是 OAuth2 登录端点、userinfo，
   以及插件调用 core 命令。
7. **商城角色不来自论坛用户组。** `admin`/`moderator` 由本仓 `store_roles` 决定。

## Stack And Directory Map

- `service/` —— Next.js App Router + TypeScript + Tailwind；Bun 作为包管理器与运行时。
  - 目标布局：`src/app/`（公开前台 / dashboard / moderation）、`src/app/api/v1/`、`src/lib/`
    （oauth client、github app、detection、storage）、`src/worker.ts`（pg-boss）。
  - PostgreSQL 16 + Drizzle ORM + drizzle-kit；队列用 pg-boss，独立 worker 进程、同镜像。
  - 图片：`file-type` 验魔数 + `image-size` 读尺寸，内容寻址存储；**不引入 `sharp`**。
- `plugin/` —— 仓库根即 SForum 的 `EXTERNAL_EXTENSION_ROOTS` 源根，扩展包在
  `plugin/plugins/sforum.store/`。
  - Go 后端 `require github.com/zhuchunshu/sforum/apps/api v0.0.0` + 本地 `replace`；
    CI 用 `go mod edit -replace` 指向 SForum 检出。
  - 管理页是**预构建** ESM/CSS（Admin Micro-frontend API v1），构建产物进包，源码不进运行时。
- `contracts/store-api.yaml` —— 唯一跨产物契约。
- `knowledge/` —— 项目记忆。`plans/` 任务书、`decisions/` 决策记录、`sessions/` 热交接。
- `docs/` —— 部署、开发者接入、GitHub App 注册步骤。

## Commands

**尚未落地。** S0（仓库骨架 + 契约 + CI）批准后才会有真实脚本；在那之前不要凭空写
`bun run dev` 之类的命令然后声称可用。目标形状（S0 交付，非现状）：

```bash
bun install                 # 唯一包管理器；出现 pnpm-lock.yaml 视为错误
bun run --filter service dev
bun --bun next build        # Bun 运行时闸门
bun run db:generate         # drizzle-kit
```

网络依赖命令前按需设置本地代理（与 SForum 仓一致）：
`export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897`

## 运行时闸门

Bun 跑 Next.js 生产运行时是**待验证项**，不是信仰。CI 必须跑一次 `bun --bun next build` +
启动冒烟（`/api/health` + 一页 SSR）。若原生依赖失败，**只允许 `next start` 回退 Node**，
构建与脚本保持 Bun。回退判定以 CI 证据为准，不接受「应该能跑」。

## 身份与会话（实测约束，照抄）

这些来自 `sforum-oauth2-provider` 的实现与实测，不是可选优化：

- 端点：`/api/oauth/{authorize,consent,token,userinfo,revoke,introspect,csrf}`。
- **所有插件路由都在宿主 CSRF 中间件后**。服务端换 token / refresh / revoke 必须：
  `GET /api/oauth/csrf` 拿 `csrf_` cookie → 再带 `X-Csrf-Token` 与 `Origin: <forum>` 发 POST。
  标准 OAuth 库直接接会 403。
- **客户端凭据只能放请求体**：Host 以 filtered authority 交付，`Authorization` 头到不了插件
  路由。不要用 HTTP Basic。
- **userinfo 只认 `access_token` 查询参数**，不读 `Authorization`。
- 授权码必须带 PKCE（S256，base64url 无填充）；回调地址精确匹配，生产要求 `https`，本地
  允许 `http://127.0.0.1` / `http://localhost`。
- `sub` 只在单个 issuer 内稳定。账号唯一键必须是 `(issuer, sub)`，永远不要用 `username`。
- `client_secret` 轮换是**单哈希覆盖**，没有双 secret 宽限；但 refresh token 绑 `client_id`
  不绑 secret，所以轮换不需要让用户重新登录。轮换步骤：论坛后台 rotate → 更新配置 → 滚动重启。
- scope 有内建回退：请求不带 `scope` 时服务端用应用登记的默认集合。`profile` 恒授予。
- 商城会话用 `__Host-store_session`（HttpOnly / Secure / SameSite=Lax），PG 持久化，支持撤销
  其它设备；会话轮换在登录成功时进行。

## GitHub App

- 权限只要 `Contents: read` + `Metadata: read`；不申请 `Administration`、`Actions`。
- 事件订阅：`release`、`installation`、`installation_repositories`、`repository`。
  少订 `repository` 会让仓库改名/转移/转私有静默失效。
- App JWT ≤10 分钟；installation token 每小时换，缓存到过期前 60 秒；私钥只从环境/密钥管理
  读取，支持多私钥（`kid`）以便轮换。
- Webhook 必须验 `X-Hub-Signature-256`，按 `X-GitHub-Delivery` 幂等；事件处理只入队，不在
  请求内做重活。
- 仓库身份用 `repo_id`，`full_name` 只是显示字段。

## 检测与版本

- 平台判定顺序：`debug/buildinfo` → ELF/Mach-O 头 → 文件名；每次兜底写 `detection_source`。
  主题没有后端二进制 → `any/any`。
- 版本以**清单**为准（`sforum.extension.json` 的 `version`），release tag 只是标签。
- 清单里的 `sforumVersion` 是 **semver 约束**（Masterminds 语义），不是版本号；按等值比较
  一定是错的。
- 一个 ZIP 只含一个扩展：解析入口只会返回单个清单。多扩展仓库 = 一个 tag 挂 N 个 ZIP。
- 摘要一律流式 SHA-256；release 若带 `checksums.txt`/`SHA256SUMS` 必须交叉校验。

## 分发

- 下载短链携带：asset id、sha256、exp；服务端在下发时复核「仍是当前发布版本且未 yank」。
- 响应头：`Content-Type: application/zip`、`Content-Length`、`Content-Disposition: attachment`、
  `X-Content-Type-Options: nosniff`、`Cache-Control: private, no-store`。
- TTL 与 SForum 安装意图的过期时间必须兼容（见任务书 §10 Q5）；不要把「单次」写进文档除非
  它真的可执行。

## 安装交接

- 只调用 `sforum.extensions.install.plugin@1` / `.theme@1` 与 `sforum.extensions.install.status@1`。
- 输入是 `url` + `sha256`（+ 可选 `expectedExtensionId` / `expectedVersion`）；输出是
  `intentId` + 状态。商城不得假定自己能触发启用。
- 状态机：`pending → running → staged | failed | expired`。`staged` 的文案是「已暂存，去完成
  信任/升级」，**不能**写「已安装」或「已更新」。
- 安装必须由人类管理员当场触发；不做后台静默安装，不做自动升级。

## 数据与身份规则

- 账号：`(issuer, sub)` 唯一；产品归属 `owner_account_id`。
- `extension_id` 跨仓库全局唯一；冲突由审核裁决，不做先到先得。
- 产品生命周期与上游连通性**分开表达**（详见任务书 §10 Q2）：不要把所有状态塞进一个 enum。
- 每个新权限键都要同时更新种子、展示文案、契约与知识库；前后端都要有 allowed/denied 测试。
- 越权一律按 404 处理，不泄漏资源存在性。

## 后端与前端约定

- 路由处理只做解码/编码与传输；业务在领域服务；SQL 在 store。不要在一个函数里混合 SQL、
  解析、策略与响应格式化。
- 单文件 500 行是复查信号，1000 行是硬警告；按职责拆分，不按行数硬切。
- 页面路由保持壳：元数据、查询状态、SSR 编排、组合。大块表单/表格/检查器放特性组件。
- 图标只用图标库（Tabler / Lucide）。**不用 emoji 当图标、状态标记或装饰**。
- 不手绘内联 SVG 图标。插件管理页拿不到 Host 图标运行时，按钮用文字。
- i18n：UI 默认 `zh-CN`，其次 `en-US`；产品文案走 `product_translations`，回退默认语言。
- 后台页面改动要有 1633×810 与 390×844 的渲染证据（对齐、溢出、可访问名称），源码与单测不算
  视觉验收。
- 成功动作给 Toast；阻塞错误留在表单旁，错误 Toast 不自动消失。

## 安全

- 出站白名单：GitHub API、对象存储。商城不接受用户提交的抓取 URL，因此不需要通用 SSRF 抓取器。
- 上传：PNG/JPEG/WebP，魔数 + 尺寸校验，**禁 SVG**，随机文件名，长缓存。
- changelog 与描述在服务端消毒后输出；不信任开发者 HTML。
- 登录、提交、下载、恢复仓库各有独立限流；管理动作写审计。
- 私钥、`client_secret`、token 加密密钥只从环境/密钥管理读取，永不进日志。

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

见 `knowledge/index.md`。当前只有骨架与任务书，S0 之前不写产品代码。
