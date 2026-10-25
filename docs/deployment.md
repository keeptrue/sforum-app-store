# 部署

商城是**一个独立 Web 服务**（Next.js + Bun）+ 一个 **PostgreSQL 16** 数据库（队列 pg-boss 同库）。
它不进入任何论坛的请求链路；论坛只通过 OAuth2 登录端点、userinfo 与插件管理页的宿主安装动作
和它接触。

## 1. 部署矩阵

| 场景 | 身份提供方 | GitHub App | 图片存储 | 下载 |
| --- | --- | --- | --- | --- |
| 官方商城 | 官方论坛的 OAuth2 client | 官方 App（公共安装） | 本地卷 | 商城签名代理 |
| 自部署商城 | 自己论坛的 OAuth2 client | 自己注册的 App | 本地卷 | 商城签名代理 |
| 纯内网/离线（未实现） | 自己论坛 | 自建 App | 本地卷 | 需自建镜像与签名快照 |

官方 App 不服务任何外部实例：自部署必须注册自己的 App。App 凭据不读 env，而是后台
「GitHub App」页里的一项运行时配置；没配时服务照常启动，webhook、安装流程、仓库同步与下载代理
分别返回 503 与 `github_not_configured`（见 `docs/github-app.md`）。

## 2. 必需环境变量

服务端**没有默认值可依赖**的变量缺失时启动失败，不会降级成「部分可用」。

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串（建议 `?sslmode=require`） |
| `STORE_PUBLIC_URL` | 对外基址的**种子**：启动必填，但生效地址 = 后台「系统设置」保存的值 > 本变量。OAuth 回调、签名下载短链、GitHub webhook / Setup URL、`isSameOrigin` 基准都由生效地址推导。生产必须 `https`（只有 `127.0.0.1` / `localhost` 允许 http）。换入口不必改它，见下面的「改对外地址（后台即可，不用重启）」 |
| `STORE_SESSION_SECRET` | 会话签名，≥ 32 字符 |
| `STORE_DOWNLOAD_SECRET` | 下载 token HMAC 密钥，≥ 32 字符；轮换会让已签发链接立即失效 |
| `STORE_SECRET_KEYS` | `kid:base64(32B)` 列表，AES-256-GCM 加密 issuer secret、论坛 token、GitHub App 的 webhook secret 与私钥；最后一个是写入用 |
| `STORE_ADMIN_SETUP_TOKEN` | 创建**首个管理员**的一次性令牌，≥ 32 字符（`openssl rand -base64 32`）。不配则注册入口关闭 |

可选：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `STORE_ASSET_DIR` | `service/.data/assets` | 内容寻址图片根目录，必须持久化 |
| `STORE_BUILD_VERSION` / `STORE_BUILD_COMMIT` | `dev` / `local` | `/api/health` 与页脚 |
| `STORE_ADMIN_PATH` | `admin` | 后台路径段，单段；与 `/api`、`/dashboard`、`/moderation`、`/p`、`/_next` 冲突会启动失败。改完重启即生效，不用重建镜像 |
| `STORE_RATELIMIT_LOGIN` | `10/300` | 按 IP |
| `STORE_RATELIMIT_ADMIN_LOGIN` | `10/300` | 按 IP，后台密码登录 |
| `STORE_RATELIMIT_SUBMIT` | `30/3600` | 按账号，dashboard 写操作 |
| `STORE_RATELIMIT_DOWNLOAD_IP` | `60/300` | 按 IP |
| `STORE_RATELIMIT_DOWNLOAD_TOKEN` | `20/300` | 按 token（库里只存 hash） |
| `STORE_RATELIMIT_REPO` | `30/3600` | 按账号，连接仓库 |
| `STORE_DOWNLOAD_MODE` | `proxy` | 下载分发形态的**种子**（后台「系统设置」可覆盖，见下）。`proxy` 由本机转发字节（一条信任链、yank 即时 410、带宽自付）；`redirect` 对**公开仓库**直接 302 到 GitHub 已签好的对象地址，本机不承担带宽，但已发出的 302 无法撤销，私有仓库仍走代理。只认这两个值，写错启动即失败。取舍见 `knowledge/decisions/2026-10-25-download-redirect-mode.md` |
| `STORE_DEV_ORIGINS` | 空 | **仅 `next dev`**：额外允许跨源访问 dev 端点的 host，逗号分隔，`*` 匹配一段子域。经反代或隧道访问 dev server 时必须配，否则 Next 对 `/_next/*` 与 `/__nextjs*` 一律 403 |

限流格式是 `<次数>/<秒>`；写错会在启动时抛 `ConfigError`，不会静默变成「不限流」。

`STORE_RATELIMIT_*` 六项都是**默认值层**，可被后台「系统设置」逐通道覆盖（留空的通道继承
本层；`--clear` 让六个通道全部退回本层）。后台保存的值不允许低于 3 次/窗口（`admin-login`），
再低就会把运营锁在后台外面；env 层没有这条下限。

GitHub App 的凭据**不在上表**：App ID、slug、API base URL、webhook secret 与签名私钥是运行时
配置，登录后台在 `/<STORE_ADMIN_PATH>/settings/github` 里填（默认 `/admin/settings/github`），
存进 `github_app_config` + `github_app_private_keys` 并用 `STORE_SECRET_KEYS` 加密。
`GITHUB_APP_ID` / `GITHUB_APP_SLUG` / `GITHUB_WEBHOOK_SECRET` / `GITHUB_APP_PRIVATE_KEYS` /
`GITHUB_API_BASE_URL` 已于 2026-10-25 移除，env 里残留也不读。步骤见 `docs/github-app.md`。

### 论坛侧（sforum-oauth2-provider）的三个硬条件

这三条都来自对真实 provider 的复核（2026-10-24），不满足时表现为登录失败而不是启动失败：

1. `client_id` 长度 8..128。provider 的 `token.request.json` 声明了这个区间，宿主在 handler
   之前校验；更短的 client_id 会在每次登录换 token 时得到 **422
   `extensions.route_schema_invalid`**，日志里看不出是「client_id 太短」。
   后台新增 issuer 的表单会先按同一区间拦下（`lib/admin/issuers.ts`），但**只覆盖表单写入**：
   手工 `insert` 或从旧环境迁移来的行不会因此启动失败，登录却同样会 422。已有部署请核对一次：

   ```sql
   select issuer_key, base_url, client_id from oauth_issuers;
   -- 需要改时（client_id 不是 secret，可以明文改）
   update oauth_issuers set client_id = 'store-client' where issuer_key = 'official';
   ```

   本地用 fake provider（`test/fake-provider.ts`）时也一样：它按真实 provider 的 schema 校验，
   短 id 会被同一个 422 挡住。
2. 回调地址精确匹配 `<生效地址>/api/auth/sforum/callback`（生效地址见下面「改对外地址」一节）；
   生产要求 `https`，只有 `http://127.0.0.1` / `http://localhost` 允许明文。
3. **论坛必须看到正确的 scheme**。商城换 token 时带 `Origin: <base_url 的 origin>`，宿主的
   CSRF 中间件要求它与本次请求的 `scheme://host` 一致（或出现在
   `CSRF_TRUSTED_ORIGINS`）。论坛在 TLS 终止反代后若没开 `TRUST_PROXY`（或没配
   `TRUSTED_PROXIES`），宿主看到的 scheme 是 `http` 而 Origin 是 `https` → 每次换 token
   都是 **403 `csrf.origin_invalid`**。排查顺序：先看论坛是否信任反代，再看
   `CSRF_TRUSTED_ORIGINS` 是否包含公开站点 origin。

### 反向代理与隧道（Cloudflare Tunnel 等）

对外地址是这个进程**对自己住址的认知**，不是一句提示文案。下面这些都从**生效地址**推导
（`lib/settings/runtime.ts` 的 `getRuntimeConfig`：后台保存的值 > `STORE_PUBLIC_URL` 种子，
进程内缓存 15 秒；后台保存会立刻让本进程的缓存失效）：

- OAuth `redirect_uri`（`sforumCallbackUrl`）
- 登录成功/失败重定向、`errorRedirect`
- `isSameOrigin` 的比较基准（`lib/auth/http.ts`）—— 写操作 403 的唯一来源
- cookie 名与 `Secure`：`https` → `__Host-store_*`，`http` → `store_*`
- 下载短链、GitHub webhook / setup URL

所以**换入口 = 换生效地址**（后台「系统设置」里改，保存即生效），不是「只把隧道指过来」。
两者不一致时的症状：

| 症状 | 机制 |
| --- | --- |
| 点登录没反应 / 白屏 / `state_mismatch` | 回调地址指向 `127.0.0.1`，而 state cookie 设在隧道域；浏览器按域隔离，回调读不到它 |
| 所有写操作 403 `origin_mismatch` | `Origin` 是隧道域，比较基准是 `127.0.0.1`。进程日志里有 `[auth] rejected a cross-origin mutation`，带 expected 与 actual |
| 登录成功但仍是未登录 | 生效地址是 `https`（发 `__Host-` cookie）而实际用 `http://` 打开，浏览器直接丢弃该 cookie |
| dev 下错误覆盖层与 HMR 全 403 | `next dev` 的 `blockCrossSiteDEV` 只放行 `allowedDevOrigins` |

换入口的完整 checklist：

1. `cloudflared tunnel --url http://127.0.0.1:4000`，记下域名。
2. 后台「系统设置」把对外地址改成 `https://<域名>`（协议 + host 与地址栏完全一致，无尾斜杠），
   保存。**只有第一次启动、还进不去后台时**才改 `STORE_PUBLIC_URL` 并重启进程。
3. 论坛后台把该 OAuth 应用的 Redirect URI 改成 `https://<域名>/api/auth/sforum/callback`
   （精确匹配，见上面第 2 条硬条件）。
4. `curl -s https://<域名>/api/health`，核对返回里的 `publicUrl` / `publicUrlSource` /
   `cookieSecure` / `sessionCookie` 是否与地址栏一致。
5. 跑 `next dev` 时额外设 `STORE_DEV_ORIGINS=<域名>`，重启 dev。quick tunnel 域名每次变，
   可以写 `*.trycloudflare.com`。
6. **授权端点也必须对外可达**。issuer 的 `base_url` 若是 `http://127.0.0.1:3000`，从外网访问
   的浏览器打不开它 —— 要么给论坛也开一条隧道、把 issuer 的 `base_url` 改成那条地址
   （后台「OAuth2 配置」，issuer 是 DB 行不是 env），要么只在同机浏览器上验证。

不要用 `X-Forwarded-Host` / `Host` 动态推导对外地址：这两个头由请求方控制，等于把 OAuth
回调与下载短链的落点交给攻击者。也不要把 `isSameOrigin` 放宽成「接受任意 Origin」——那拆的是
CSRF 防护（它现在接受的两个值见下一节）。

#### 静态资源缓存会掩盖 CSS 改动（dev 实例必读）

`next dev` 的 CSS chunk 名是**固定**的（`/_next/static/chunks/[root-of-the-server]__<hash>._.css`
里的 `<hash>` 不随样式内容变化），而 Cloudflare 会给它一个四小时的浏览器缓存
（实测 `cache-control: max-age=14400, must-revalidate` + `cf-cache-status: REVALIDATED`）。
结果是：改了 `globals.css`，浏览器可能仍在用旧文件，页面看起来「样式没生效」。

判断方法（在页面控制台跑）：

```js
[...document.styleSheets]
  .filter((s) => s.href)
  .map((s) => ({ href: s.href.split("/").pop(), rules: s.cssRules.length,
                 hasReadme: [...s.cssRules].some((r) => r.cssText.startsWith(".readme")) }))
```

`transferSize === 0` 说明命中了磁盘缓存；规则数比源码里少、或者该有的选择器不在，就是旧文件。
处理：`Ctrl+Shift+R`，或 purge Cloudflare 的 `/_next/static/*`。

长期二选一：

- 共享测试域名改跑生产构建（`bun run build && bun run start`）。产物的 chunk 名带内容哈希，
  缓存天然安全；代价是没有 HMR。
- 留在 dev，但加一条 Cache Rule 让 `/_next/static/*` 与 HTML 走 bypass。

生产构建不受这个问题影响，但同样值得在代理层确认 `/_next/static/*` 的 `Cache-Control`
是长缓存（`immutable`）——那是内容哈希文件唯一正确的策略。

#### 重启 `next dev` 时先清 `.next`

换进程但复用上一个进程写下的 `.next`，Turbopack 可能进入「每个请求都重编译」的状态：日志里
`✓ Compiled in 1ms` 紧跟在每一条 `GET` 前面，dev 客户端收到编译事件后不断整页重载，浏览器看起来
在自动刷新。判断方法很简单——空闲时 `wc -l` 两次日志，行数应当不变：

```bash
a=$(wc -l < /tmp/sforum-dev.log); sleep 5; b=$(wc -l < /tmp/sforum-dev.log); echo $((b-a))
```

不是 0 就 `rm -rf service/.next` 再启动。生产构建没有这个状态，只有 dev 有。

### 改对外地址（后台即可，不用重启）

入口：`/<STORE_ADMIN_PATH>/settings/general`（默认 `/admin/settings/general`），侧栏
**配置 → 系统设置**。同一页还能改下载短链有效期（默认 1800 秒，范围 300–86400）、下载分发形态
（商城转发 / 302 直链 / 跟随 `STORE_DOWNLOAD_MODE`）与六个限流通道。
解析顺序固定：`store_settings` 行 > `STORE_PUBLIC_URL` / `STORE_DOWNLOAD_MODE` 种子。`STORE_PUBLIC_URL` 仍然启动必填，
但语义是「种子/默认值」：后台「恢复默认」或 `--clear` 删行后回到它。

保存后跟着变的（同一个进程的下一个请求就生效）：

- OAuth `redirect_uri`、登录成功/失败重定向与 `errorRedirect`
- 下载短链：新签发的链接用新地址，有效期取这一页的「下载有效期」
- GitHub App 的 Webhook URL 与 Setup URL（后台「GitHub App」页里那两个只读地址随之变化；
  安装链接由 slug 拼，不受影响）
- `isSameOrigin` 的基准
- cookie 名与 `Secure`

必须同步改的三处外部登记（商城不会替你做）：

1. 论坛后台该 OAuth 应用的 Redirect URI → `<新地址>/api/auth/sforum/callback`（精确匹配，
   见上面「三个硬条件」第 2 条）。
2. GitHub App 的 **Webhook URL** → `<新地址>/api/github/webhook`，**Setup URL** →
   `<新地址>/api/github/setup`（是两格不同的输入，见 `docs/github-app.md`）。
3. 插件设置 `sforum.store.catalog_base_url` → 新的 https 基址（留空时管理页只显示配置提示、
   不发任何请求）。

三个后果，保存前先确认：

- **http ↔ https 会让所有人重新登录**，管理员也一样。cookie 名与 `Secure` 跟随生效地址的协议
  （https → `__Host-store_*`），协议一变旧 cookie 全部作废。这是刻意的：不按请求协议派生，
  否则 http 下就能拿到非 `Secure` 的会话 cookie。
- **已签发的下载短链只在旧地址仍可路由时有效**。token 不绑域名，链接里的 host 是签发时的地址；
  旧域名一停解析，链接就是死链（TTL 内也一样）。
- **多副本最多 15 秒收敛**。保存它的进程立刻失效缓存并回读，所以那个进程下一个请求就是新值；
  其它副本与 worker 靠 15 秒 TTL 收敛。没有 LISTEN/NOTIFY，这是刻意不做的（少一个故障模式，
  代价是几秒窗口）。

两个确认闸门（`PUT /api/admin/settings`）：

| 条件 | 返回 | 需要的字段 |
| --- | --- | --- |
| 新地址的 origin 与本次请求的 origin 不一致 | 409 `confirm_origin_change` | `confirmOriginChange: true` |
| 当前请求是 http 而新地址是 https | 409 `confirm_insecure_transition` | `confirmInsecureTransition: true` |

第二条的理由：`__Host-` cookie 在 http 下写不进去，保存后浏览器直接丢弃会话 cookie，而能改回来
的那一页又要求登录——TLS 没就位时这就是自锁。

自锁恢复（后台进不去时，不用重启）：

```bash
bun run settings:public-url -- --show            # 当前生效地址 + 它来自哪一层
bun run settings:public-url -- --set https://store.example.com
bun run settings:public-url -- --clear           # 删行，回到 STORE_PUBLIC_URL 种子
```

根目录与 `service/` 都能跑；脚本自己读 `.env.local` 补 `DATABASE_URL`。`--set` 不写
`updated_by_admin_id`，不会抹掉后台最后一次修改人。

改完的核对口是 `/api/health` 的 `publicUrl` / `publicUrlSource`（`database` | `env`）/
`settingsUpdatedAt` / `configWarning`；数据库不可达时它仍返回 200，回退种子值并在
`configWarning` 里说明。

**同源校验为什么没被拆**：`isSameOrigin` 现在接受「配置的 origin」**或**「请求自身的 origin」
（`x-forwarded-host` / `Host` + `x-forwarded-proto`）。后者是浏览器 `Origin` 的标准校验对象，
跨站页面伪造不了它，所以 CSRF 强度不变；好处是刚改完地址、代理还没就绪时，后台自己的写操作
不会 403 把运营锁死。

## 3. 首次启动

```bash
bun install --frozen-lockfile
bun run db:migrate                 # 需要 DATABASE_URL（.env.local）
cd service && bun --bun next build
bun --bun next start -p 4000       # 或交给进程管理器（默认端口已由 package.json 固定为 4000）
curl -s http://127.0.0.1:4000/api/health   # {"status":"ok",...}
```

worker 必须单独起一个进程（同镜像、同环境变量）：

```bash
bun run worker
```

**没有 worker**，GitHub webhook 只会入队不处理，release 永远不会同步。

### 初始化顺序（2026-10-25 起，比之前多两步）

`STORE_BOOTSTRAP_ISSUER` 与 `STORE_BOOTSTRAP_ADMINS` **已删除**：管理员是商城本地账号，
OAuth2 issuer 全部由后台配置。空库第一次部署按这个顺序走：

1. **生成 setup token**：`openssl rand -base64 32` → 写入 `STORE_ADMIN_SETUP_TOKEN`，重启。
2. **注册首个管理员**：打开 `${STORE_PUBLIC_URL}/${STORE_ADMIN_PATH}`（默认 `/admin`）。
   库里没有管理员时它会跳到 `/setup`；填 token、用户名、密码。成功后这个入口**永久关闭**
   （再访问是 404）。
3. **登录后台**：`/${STORE_ADMIN_PATH}/login`，用刚建的用户名密码。
4. **配置 OAuth2**：先按 `docs/oauth-setup.md` 在论坛后台建一个**机密**客户端，回调地址填
   `${STORE_PUBLIC_URL}/api/auth/sforum/callback`；再回后台「OAuth2 配置」→ 新增 issuer，填
   `issuer_key`、论坛地址、`client_id`、`client_secret`、scopes，保存后点「测试连接」。
   **一个商城只接入一个论坛**：启用中的 issuer 只能有一个（数据库部分唯一索引强制），换论坛要先停用
   当前的。**在这一步完成之前，论坛用户无法登录**，前台会显示「还没有配置登录来源」而不是 500。
5. **验证**：用论坛账号打开 `/dashboard`，走完一次登录。

> 管理员账号与论坛账号是两条独立身份线：管理员不来自论坛，论坛账号也永远不是管理员。
> 同一自然人既要管后台又要发扩展时会有两个账号行——这是刻意的取舍，见
> `knowledge/decisions/2026-10-25-admin-local-identity.md`。

**忘记管理员密码**：没有邮件找回。首选让另一个管理员在「账号与角色」里重置；如果那是唯一
的管理员（或所有人都被锁在外面），在服务器上跑下面任意一条：

```bash
# 有终端：隐藏输入，读两次
cd service && bun run admin:password -- <username>

# 没终端 / 要写进 runbook 或脚本：密码从管道来，或直接生成
bun run admin:reset-password -- <username> --generate          # 生成 24 字符随机密码，stdout 只有密码
printf '%s\n' "$NEW_PASSWORD" | bun run admin:reset-password -- <username> --password-stdin
bun run admin:reset-password -- --list                         # 先看有哪几个账号
```

两条命令做同一件事：换掉密码哈希、清掉锁定与失败次数、结束该账号的全部会话，并写一条
`admin.password.reset_cli` 审计。`admin:reset-password` 只是把「密码怎么给」变成可脚本化
（`--generate` / `--password-stdin`），另加 `--keep-sessions`（保留现有会话）、`--json`
（机器读）和 `--list`；退出码 0 成功 / 1 参数或环境错误 / 2 账号不存在 / 3 密码不合格。
明文既不进 shell 历史也不进日志。

## 4. GitHub App 注册（约 10 分钟）

分两半：先在 GitHub 上建 App，再把它的凭据填进后台。**没有 env 步骤，也不需要重启**——
保存后 web 与 worker 各自在 15 秒内读到新配置（进程内缓存）。

### 4.1 在 GitHub 上建 App

1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App。
2. Homepage URL：商城生效的对外地址（后台「系统设置」里显示，或 `/api/health` 的 `publicUrl`）。
3. Webhook URL：`<对外地址>/api/github/webhook`（由生效地址推导，后台「GitHub App」页直接复制）。
4. Webhook secret：`openssl rand -hex 32` 生成，**同一个值**一会儿填进后台；两边不一致的表现是
   每次投递都 `401 invalid_signature`。
5. 权限：**Contents: read**、**Metadata: read**、**Actions: read**。不要申请 Administration。
6. 订阅事件：`release`、`installation`、`installation_repositories`、`repository`。
   少订 `repository` 会让仓库改名/转移/转私有静默失效。
7. Setup URL（安装后跳转，不是 Callback URL）：`<对外地址>/api/github/setup`。
   填错这一格的表现是安装完成后停在 GitHub、本地没有 `github_installations` 行。
8. 创建后记下 **App ID** 与 **slug**（slug 就是 `github.com/apps/<slug>` 里那段）。
9. 页面下方 **Generate a private key**：下载 `.private-key.pem`，内容是 PKCS#8 PEM。

`Actions: read` 只用于审核页展示 release 所指 commit 的 workflow run，**不是**发布闸门；
界面不得出现「已验证构建」。

### 4.2 在后台填写

1. 登录后台，打开 `${STORE_PUBLIC_URL}/${STORE_ADMIN_PATH}/settings/github`
   （默认 `/admin/settings/github`）。
2. 填 **App ID**、**slug**、**webhook secret**，把 `.private-key.pem` 的内容整段粘进私钥框
   （不用 base64，不用改行尾）。**API base URL** 只有 GitHub Enterprise Server 才改，其余留空
   （即 `https://api.github.com`）。
3. 点「保存并启用」（之后是「保存修改」）。私钥以公钥指纹标识、用 `STORE_SECRET_KEYS` 加密
   入库；界面之后只显示指纹，不回显私钥。
4. 点「验证」：它用 App JWT 调 `GET /app`，一次回答三件事——App ID 存在、私钥是配对的那把、
   后台存的 slug 与 App 真实 slug 一致。slug 填错时表单能存下去，但安装链接会 404，所以这步别跳。
5. 开发者门户打开仓库选择器，点「连接 GitHub」（`/api/github/install/start`）走一次安装，回调
   落到 `/api/github/setup` 记下 installation；回来点「从 GitHub 同步」把仓库拉到本地。

轮换 webhook secret、轮换私钥（先加后删）、以及没配 App 时各处返回什么，见 `docs/github-app.md`。

## 5. 备份与恢复

备份两样东西：数据库与资产卷。

```bash
# 备份
pg_dump --format=custom --file=store-$(date +%F).dump "$DATABASE_URL"
tar -C "$STORE_ASSET_DIR" -czf assets-$(date +%F).tar.gz .

# 恢复到新库（演练与灾难恢复同一套命令）
createdb store_restore
pg_restore --dbname=store_restore --no-owner --clean --if-exists store-2026-10-24.dump
tar -C /srv/store/assets -xzf assets-2026-10-24.tar.gz
```

恢复后把 `DATABASE_URL` 指向新库、`STORE_ASSET_DIR` 指向恢复出来的卷，启动并验证：

```bash
curl -s "$STORE_PUBLIC_URL/api/v1/catalog" | head -c 200   # 目录应恢复
curl -s -o /dev/null -w '%{http_code}\n' "$STORE_PUBLIC_URL/api/assets/<sha256>"
```

**资产卷丢失不会让服务崩溃**：图片 404、产品页缺图标/截图，其余功能正常。数据库丢失则一切
归零——数据库是真相，卷是可重建的派生数据（前提是重新上传）。

`rate_limits` 可以安全清空（`TRUNCATE rate_limits`），清空等于重置所有窗口。

## 6. 升级与回滚

升级：

```bash
git fetch && git checkout <tag>
bun install --frozen-lockfile
bun run backup:legacy-media   # 0011 起：先把旧图标/截图/介绍引用 dump 到 tmp/
bun run db:migrate            # 迁移只前进
cd service && bun --bun next build
# 重启 web 与 worker
```

`backup:legacy-media` 只在升级到含迁移 `0011_github_only_products` 的版本时需要，且必须
**在 `db:migrate` 之前**跑：该迁移删除 `products.icon_asset_id`、`product_screenshots` 表与
`product_translations.description_md`。脚本只读，输出 `tmp/legacy-media-<ts>.json`（产品图标引用、
截图行、介绍文本、资产 sha 与文件是否存在）；`assets` 行与磁盘文件本身不会被删。

迁移之后 `product_readmes` 是空表：产品会在下一次被访问、下一次 release 同步，或管理员在门户点
「重新拉取」时补上 README。需要一次性预热时可以逐个产品点一次，或等访问触发。

回滚（应用层）：

```bash
git checkout <previous-tag>
bun install --frozen-lockfile
cd service && bun --bun next build
# 重启；数据库保持在新迁移上
```

**迁移不回滚**：本项目不提供 down migration。回滚前先确认旧代码能读新 schema（本项目至今
只做加列/加表，属于向后兼容）；若某次迁移是破坏性的，回滚流程必须改成「恢复备份」而不是
「回退代码」。回滚演练见任务书 §7.6 与 `knowledge/sessions/archive/2026-10/2026-10-24-s6-hardening.md`。

## 7. 健康与告警

- `/api/health` 返回 `{status,version,commit,time}`，外加 `publicUrl` / `publicUrlSource` /
  `settingsUpdatedAt` / `sessionCookie` / `cookieSecure` / `nodeEnv`；配置读不出来时多一个
  `configError`，状态码仍是 200（存活探针不因缺 env 变成 500）。`publicUrl` 是给反代/隧道排查
  用的：和地址栏比一下，最常见的错配一条 curl 就能看出来；`publicUrlSource` 说这个值是
  `database`（后台「系统设置」保存的）还是 `env`（种子），`settingsUpdatedAt` 是那一行的
  最后修改时间。数据库不可达时它也仍返回 200：回退种子值并给 `configWarning`，所以「探针 200」
  不等于「库可用」。`Cache-Control: no-store`。要探数据库用 `/api/v1/catalog`（会打 DB）。
- 限流计数不可用时服务**fail-open**（放行 + 打 warn 日志）；这条日志就是告警点。
- worker 的失败在 `webhook_deliveries.status`、`repo_releases.sync_state`、`release_versions.state`
  里可查；没有独立指标端点。
