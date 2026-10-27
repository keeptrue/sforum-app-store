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

走 Docker Compose（§3）时这五项不用手填：`scripts/docker/bootstrap.sh` 首次运行就生成它们。
手工部署照上表自己填。

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
| `STORE_RATELIMIT_DOWNLOAD_ACCOUNT` | `60/300` | 按商城账号（`account_required` 模式下的签发） |
| `STORE_RATELIMIT_INSTALL_AUTH_START` | `10/300` | 按 IP，发起「连接商城」授权 |
| `STORE_RATELIMIT_INSTALL_AUTH_POLL` | `120/300` | 按授权请求 id 轮询；另有 2 秒下限（超出回 429 `slow_down`） |
| `STORE_RATELIMIT_INSTALL_AUTH_TOKEN` | `10/300` | 按授权请求 id 兑换令牌 |
| `STORE_RATELIMIT_REPO` | `30/3600` | 按账号，连接仓库 |
| `STORE_DOWNLOAD_MODE` | `proxy` | 下载分发形态的**种子**（后台「系统设置」可覆盖，见下）。`proxy` 由本机转发字节（一条信任链、yank 即时 410、带宽自付）；`redirect` 对**公开仓库**直接 302 到 GitHub 已签好的对象地址，本机不承担带宽，但已发出的 302 无法撤销，私有仓库仍走代理。只认这两个值，写错启动即失败。取舍见 `knowledge/decisions/2026-10-25-download-redirect-mode.md` |
| `STORE_DOWNLOAD_AUTH_MODE` | `anonymous` | 下载签发是否要求商城账号的**种子**（后台「系统设置 → 下载登录要求」可覆盖）。`anonymous`：已发布即可安装；`account_required`：签发前必须有账号令牌，浏览器前台下载也要先登录。切换前先读完下面的「安装闸门」一节——旧插件会收到 401。只认这两个值，写错启动即失败 |
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
3. 插件设置 `sforum.store.catalog_base_url` → 新的 https 基址（默认
   `https://app-store.dalao.me`；清空并保存后管理页只显示配置提示、不发任何请求）。

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

## 3. Docker Compose 一键部署

**推荐路径。** 机器上装了 Docker、手里有一个域名，就走这一节：web、worker、迁移与一个内置
PostgreSQL 17 由同一份 `docker-compose.yml` 拉起，镜像由 GitHub Actions 构建后放在 GHCR，
本机不需要 Bun、Node 或 Postgres。要从源码跑、自己控制构建产物的那条路保留在 §5 起；两条路
的环境变量是同一张表（§2），差异见 §3.11。

### 3.1 一条命令

```bash
git clone https://github.com/keeptrue/sforum-app-store.git
cd sforum-app-store
bash scripts/docker/bootstrap.sh
```

前置只有两样：`docker`、`docker compose` v2 插件（脚本第一步就检查，缺了直接退出）。
脚本按顺序做六件事，任一步失败都以非零码退出：

1. 没有 `.env` 就生成一份（`chmod 600`）；有就**复用，不覆盖任何已有密钥**。复用时会做一次
   地址对齐：只在 shell 显式给了 `STORE_HTTP_PORT`、且 `.env` 的地址还是 loopback 默认值时才
   改写它的端口（见 §3.4）。
2. 校验 `.env` 里必填项齐全，缺了直接列出缺哪些，不猜默认值。
3. 端口预检：宿主上 `STORE_HTTP_PORT` 已被占用就直接退出并给查进程的命令（有 `ss` 用 `ss`，
   否则 `lsof`；两个都没有时只告警）。这一步不能省 —— 宿主端口被占时 `docker compose up -d`
   的**退出码不可依赖**：全新项目首次 `up -d` 是 exit 1（web 停在 `created`），而「项目已存在、
   web 已 `created`」的再次 `up` 可能 exit 0 并留下一个没有端口映射的 web。所以预检与起完后的
   `docker port` 二次确认两道闸都不能省。
4. 拉镜像：应用镜像 + `postgres:17-alpine`（本地已有该 tag 时只拉 postgres）。
5. `docker compose up -d`，并确认 `web` 真的发布了端口（没有映射就报 `web 没有发布端口`）。
6. 等 `web` 变 `healthy`（最多 180 秒），然后打印 `/api/health` 响应体与 `docker compose ps`。

| 命令 | 用途 |
| --- | --- |
| `bash scripts/docker/bootstrap.sh` | 起整套 / 补齐（幂等，`.env` 存在就复用） |
| `bash scripts/docker/bootstrap.sh status` | `docker compose ps` |
| `bash scripts/docker/bootstrap.sh logs` | `docker compose logs -f --tail=100` |
| `bash scripts/docker/bootstrap.sh down` | 停掉，**保留** `pgdata` 与 `assets` 卷 |

### 3.2 脚本生成的密钥

首次生成 `.env` 时随机出来的（没有 `openssl` 时退回 `/dev/urandom`）：

| 键 | 生成方式 |
| --- | --- |
| `POSTGRES_PASSWORD` | `openssl rand -hex 16`（进连接串，只用 hex，免得 `/+`、`=` 要转义） |
| `STORE_SESSION_SECRET` | `openssl rand -base64 48` |
| `STORE_DOWNLOAD_SECRET` | `openssl rand -base64 48` |
| `STORE_SECRET_KEYS` | `<YYYYMM>:<openssl rand -base64 32>`，kid 取生成时的年月 |
| `STORE_ADMIN_SETUP_TOKEN` | `openssl rand -base64 32` |

地址与库一起写进 `.env`：`STORE_PUBLIC_URL=http://127.0.0.1:4000`、`STORE_HTTP_PORT=4000`、
`POSTGRES_USER=store`、`POSTGRES_DB=store`、`DATABASE_URL=postgres://store:<口令>@db:5432/store`。

两条要记住的：

- 令牌只在**首次生成** `.env` 时打印一次到终端。错过就 `grep STORE_ADMIN_SETUP_TOKEN .env`。
- `STORE_SECRET_KEYS` 是加密根。丢了它，库里用 AES-256-GCM 存的 issuer `client_secret`、
  GitHub App 私钥与 webhook secret 全部解不开，只能重新录入。`.env` 不要提交
  （`.gitignore` 已挡），也不要只存在于容器里。

### 3.3 第一次跑：默认 loopback，改对外地址

生成的 `.env` 里 `STORE_PUBLIC_URL` 是 `http://127.0.0.1:4000`。`production` 下 `http` 只允许
loopback（`127.0.0.1` / `localhost` / `::1`），所以这个默认值能起、能自测，但不能对外服务。
有域名时按这个顺序走：

```bash
bash scripts/docker/bootstrap.sh     # 先让脚本生成 .env 并跑通（loopback 能过健康检查）
$EDITOR .env                         # STORE_PUBLIC_URL=https://store.example.com
docker compose up -d                 # 重建容器，让新 env 生效
```

改完用一条 curl 核对**生效地址**（不是只看 `.env`）：

```bash
PORT="$(sed -n 's/^STORE_HTTP_PORT=//p' .env | tail -1)"; PORT="${PORT:-4000}"
curl -s "http://127.0.0.1:${PORT}/api/health" | grep -o '"publicUrl":"[^"]*"'
```

`publicUrl` 与地址栏不一致时的症状，以及反代/隧道要同步改的三处外部登记，见 §2 的
「反向代理与隧道」与「改对外地址」——那两节与部署形态无关，这条路线同样适用。

### 3.4 端口与卷

- 端口：`STORE_HTTP_PORT`（默认 `4000`）映射到容器内的 `4000`。容器里的 `next start` 显式带
  `-H 0.0.0.0`：不给 hostname 时它本来也绑全接口（实测 `Network: http://172.17.0.2:4000`），
  但那是默认行为的副作用、不是契约，写死地址就不用再猜「容器外访问不到」是哪一层的问题。
  改端口要**同时**改 `STORE_PUBLIC_URL` 里的端口，否则发出的绝对 URL 全是旧端口。
  `STORE_HTTP_PORT=4100 bash scripts/docker/bootstrap.sh` 这种「从 shell 传端口」的用法，脚本会
  在 `.env` 的地址仍是 loopback 默认值时自动把端口同步过去；已经写了 `https://…` 之类的地址就
  一字不动，得自己改。shell 里临时给的 `STORE_HTTP_PORT` 只影响那一次 `up`：`.env` 里的端口没变，
  下次裸 `docker compose up -d` 会回到 `.env` 的端口——要长期换端口就改 `.env`。
- 卷名是 `<compose 项目名>_<卷键>`。默认项目名取 `docker-compose.yml` 的 `name:`（`sforum-app-store`），
  用 `-p` 或 `COMPOSE_PROJECT_NAME` 换过项目名时前缀跟着变——**不要把卷名写死**，需要真名时问
  compose：

```bash
docker volume ls --filter label=com.docker.compose.volume=assets --format '{{.Name}}'
docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/sforum-store/assets"}}{{.Name}}{{end}}{{end}}' "$(docker compose ps -q web)"
```

第一条会列出本机所有项目的 `assets` 卷（有多条时按项目名认），第二条直接问当前项目的 web 容器，
所以换过项目名也准。

| 卷键 | 默认名 | 挂载点 | 内容 |
| --- | --- | --- | --- |
| `pgdata` | `sforum-app-store_pgdata` | `/var/lib/postgresql/data` | 数据库，真相 |
| `assets` | `sforum-app-store_assets` | `/var/lib/sforum-store/assets` | 内容寻址图片（`STORE_ASSET_DIR`），web 与 worker 共用 |

`pgdata` 丢了等于归零；`assets` 丢了只是图片 404、产品页缺图标（§7 的取舍对这条路线同样成立）。
容器内以 `bun` 用户（非 root）运行，`assets` 目录在镜像里已按该用户建好，命名卷首次创建会
继承它的属主。

### 3.5 内置 Postgres 与外部库

默认用 compose 里的 `db`（`postgres:17-alpine`，与 CI 同镜像），`pg_isready` 作健康检查，
`migrate` / `web` / `worker` 都 `depends_on` 它。**接外部库**只改一处：

```bash
# .env
DATABASE_URL=postgres://store:<口令>@<容器可达的地址>:5432/store
```

`db` 服务留着不碍事（它照样会起、也照样过健康检查，只是没人连它）。三点注意：

1. 容器里的 `127.0.0.1` 是**容器自己**。要连宿主机上的库，地址得是宿主在容器网络里的名字；
   compose 没有配 `extra_hosts: host-gateway`，需要自己加（仓库不提供，未验证）。
2. 外部库的角色需要对库有 **CREATE** 权限：pg-boss 12 默认 `createSchema: true`，`web` 与
   `worker` 都会去建 `pgboss` schema。权限不够时 worker 起不来。
3. `migrate` 是 `restart: "no"` 的一次性容器，但**每次 `docker compose up -d` 都会重跑一次**：
   compose 会把已 `exited(0)` 的容器重新 start。换 `STORE_IMAGE` 时它还会被重建。drizzle 迁移
   幂等，重跑无副作用；日志里出现多次 `migrations applied` 是正常的。

### 3.6 首次初始化顺序

1. `bash scripts/docker/bootstrap.sh` 跑完时迁移已经跑完：`docker compose ps` 里 `migrate` 显示
   `Exited (0)` 是**正常**的（一次性容器），不是崩溃。
2. 打开 `http://127.0.0.1:<STORE_HTTP_PORT>/<STORE_ADMIN_PATH>/setup`（默认
   `http://127.0.0.1:4000/admin/setup`），填 `STORE_ADMIN_SETUP_TOKEN`、用户名、密码。库里已经有管理员
   时这个地址是 404。脚本结尾打印的「管理后台」一行与这条 `setup` 地址同源（读 `.env` 的
   `STORE_ADMIN_PATH`，shell 里显式导出的同名变量优先，空值按 `admin`）。
3. 注册成功后删掉 `.env` 里 `STORE_ADMIN_SETUP_TOKEN` 那一行（入口本来就已经永久关闭，
   删掉只是不让令牌留在磁盘上），`docker compose up -d`。
4. `http://127.0.0.1:<STORE_HTTP_PORT>/<STORE_ADMIN_PATH>/login` 登录后台（默认
   `http://127.0.0.1:4000/admin/login`）；往下按 §6（GitHub App）与 `docs/oauth-setup.md` 走——
   那两步与部署形态无关。

忘记管理员密码时在容器里跑（镜像的 `WORKDIR` 就是 `/app/service`，脚本已拷进镜像）：

```bash
docker compose exec web bun scripts/admin-reset-password.ts -- --list
docker compose exec web bun scripts/admin-reset-password.ts -- <username> --generate
```

`--generate` 只打印一次密码，退出码 0/1/2/3 与手工路线一致（§5）。两条形态都实跑过：
`--list` 在容器里 exit 0 并列出账号，账号不存在时 exit 2。

### 3.7 升级与回滚

tag 语义见 §4.1。升级就是换 tag：

```bash
$EDITOR .env        # STORE_IMAGE=ghcr.io/keeptrue/sforum-app-store:1.2.3
docker compose pull
docker compose up -d
```

- 不写 `STORE_IMAGE` 时用 `:edge`（跟随 `main`，随时变）。要可复现就钉 semver tag。
- `migrate` **每次 `up -d` 都会重跑一次**（compose 会把已退出的容器重新 start；换 tag 时还会
  重建），所以升级时迁移一定先跑完再起 `web` / `worker`（`depends_on:
  service_completed_successfully`）。迁移失败时 `up` 停在那里，web 不会带着旧 schema 起来。
  drizzle 迁移幂等，重跑无害。
- **迁移只前进**：回滚是「tag 改回上一个版本 + `pull` + `up -d`」，数据库留在新 schema 上，
  要求旧代码能读它（本项目至今只加列/加表）。破坏性迁移只能恢复备份，见 §8。
- 升级前先备份（§3.9）。`.env` 在 `.gitignore` 里，`git pull` 不会动它。

回滚：

```bash
$EDITOR .env        # 改回旧 tag
docker compose pull && docker compose up -d
```

### 3.8 日志与健康检查

```bash
docker compose ps
docker compose logs -f web
docker compose logs -f worker
docker compose logs --tail=100 migrate
PORT="$(sed -n 's/^STORE_HTTP_PORT=//p' .env | tail -1)"; PORT="${PORT:-4000}"
curl -s "http://127.0.0.1:${PORT}/api/health"
```

镜像里定义了两个探针，`docker compose ps` 的 `STATUS` 就是它们的结果：

| 服务 | 探针 | 判定 |
| --- | --- | --- |
| `web` | `fetch /api/health` | 200 **且** `status == "ok"` **且** 没有 `configError`；10s 间隔 / 5s 超时 / 30s 启动宽限 / 6 次重试 |
| `worker` | `/proc/1/cmdline` 里有 `src/worker.ts` | 15s 间隔 / 30s 启动宽限（没有 HTTP 面可探；bun 是 PID 1） |

**`/api/health` 是存活探针，不是就绪探针。** 数据库不可达时它照样 200（回退种子地址并给
`configWarning`），所以「探针绿」不等于「库可用」；要探库打 `/api/v1/catalog`（会读 DB）。
数据库就绪由 `db` 的 `pg_isready` 负责，`web` / `worker` 靠 `depends_on` 等它，不靠这个端点。
它唯一会因为配置变红的情况是 `getConfig()` 抛错——缺必填项，或 `STORE_PUBLIC_URL` 在生产
用了非 loopback 的 `http`。那时响应里带 `configError`，健康检查判 unhealthy，容器一直重启——
这正是配置错误要立刻可见的原因。

### 3.9 备份与恢复

```bash
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > store-$(date +%F).dump
ASSETS_VOL="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/sforum-store/assets"}}{{.Name}}{{end}}{{end}}' "$(docker compose ps -q web)")"
docker run --rm --user "$(id -u):$(id -g)" -v "$ASSETS_VOL:/data:ro" -v "$PWD:/backup" postgres:17-alpine tar -czf /backup/assets-$(date +%F).tar.gz -C /data .
```

- `-T` 关掉 TTY，否则重定向出来的 dump 会被污染。
- `pg_dump` 用容器自己的 `POSTGRES_USER` / `POSTGRES_DB`，改过也不用改命令。
- 打包 assets 借 `postgres:17-alpine`（它带 busybox `tar`，bootstrap 已经拉下来了）；
  `--user` 让产物属主是你自己而不是 root。
- 上面两条命令的等价形态（`pg_dump` → 建新库 → `pg_restore` 读 stdin → 查回数据；卷 tar
  打包）已在 `postgres:17-alpine` 上实跑通过。

恢复演练（先恢复到新库，确认无误再切 `DATABASE_URL`）：

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "create database store_restore"'
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d store_restore --no-owner --clean --if-exists' < store-2026-10-27.dump
$EDITOR .env        # DATABASE_URL=postgres://store:<口令>@db:5432/store_restore
docker compose up -d
```

assets 卷恢复（不加 `--user`：容器里的 `bun` 用户要读得到这些文件，归档里的属主原样落回）：

```bash
docker run --rm -v "$ASSETS_VOL:/data" -v "$PWD:/backup" postgres:17-alpine tar -xzf /backup/assets-2026-10-27.tar.gz -C /data
```

`ASSETS_VOL` 就是上面那条 `docker inspect` 取出来的真名（默认 `<项目名>_assets`）；换过 `-p`
或 `COMPOSE_PROJECT_NAME` 时靠它而不是靠默认名。

### 3.10 常见失败

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| compose 拒绝启动：`缺少 DATABASE_URL，请先运行 bash scripts/docker/bootstrap.sh` | `.env` 缺必填项；compose 用 `${VAR:?}` 挡住，不给弱默认值 | 跑 bootstrap，或补齐 `.env` |
| `web` 一直 `unhealthy`，日志里 `STORE_PUBLIC_URL must use https in production` | `production` 下 `http` 只允许 loopback，填了非 loopback 的 http 地址 | 改成 `https://…`，或先 loopback + 隧道（§2） |
| `/api/health` 返回 200 但带 `configError` | 同上：配置错误不会让端点 500，但会让健康检查判红 | 看 `configError` 里的原文 |
| `STORE_ADMIN_SETUP_TOKEN must be at least 32 characters` | 手工填了短令牌 | `openssl rand -base64 32` |
| `宿主端口 4000 已被占用`（bootstrap 预检直接退出） | 宿主 `STORE_HTTP_PORT` 被别的进程占着 | 按提示查进程；改 `STORE_HTTP_PORT`，**同时**改 `STORE_PUBLIC_URL` 的端口 |
| `web 没有发布端口（宿主 4000 可能被占用）` | 预检漏过、`compose up` 绑端口失败（退出码不可依赖：再次 `up` 可能 exit 0 且没有端口映射） | 换端口后重跑 bootstrap；先 `docker compose down` 清掉半启动的容器 |
| `.env 缺少必填项：DATABASE_URL …`（bootstrap 自己退出） | `.env` 被手工改坏，或只填了一半 | 补上缺的键，或删掉 `.env` 让 bootstrap 重新生成（**会换掉现有密钥**） |
| `service "migrate" didn't complete successfully: exit 1` | 迁移失败 | `docker compose logs migrate`；`web` / `worker` 这时停在 `Created`，不会带着旧 schema 起来 |
| `web 容器没有起来：docker compose logs web` | `up` 之后 web 没被创建（多为 env / compose 报错） | 看日志，修完重跑 bootstrap |
| `web 在 180 秒内没有变 healthy（当前 starting）` | 首次拉镜像 / 迁移慢，或 db 还在初始化 | `docker compose ps` + `docker compose logs web`，再跑一次 bootstrap |
| `找不到 docker compose（需要 v2 插件）` | 只装了 docker CLI，没有 compose 插件 | 装 `docker-compose-plugin`（或新版 Docker Engine 自带） |
| `pull access denied for ghcr.io/keeptrue/sforum-app-store` | 包是私有的，没登录 | `docker login ghcr.io`（§4.3） |
| `migrate` 报 `server closed the connection unexpectedly` | 全新 `pgdata` 上 postgres 初始化窗口（initdb 的临时服务） | compose 已用 `pg_isready -h 127.0.0.1`（强制 TCP）+ 30s `start_period` 挡住；仍出现就重跑 `docker compose up -d`，反复出现再查库 |
| 登录成功却仍是未登录 / 写操作 403 | 不是容器问题：对外地址与地址栏不一致 | §2「反向代理与隧道」的症状表 |

### 3.11 与手工部署的差异

| | Docker Compose（本节） | 手工（§5 起） |
| --- | --- | --- |
| 运行时 | 镜像内 Bun，宿主只要 docker | 宿主装 Bun，`bun run build` + `next start` |
| Postgres | 内置 `db` 服务，或改 `DATABASE_URL` 接外部 | 自备 |
| 迁移 | `migrate` 一次性容器，每次 `up -d` 都重跑（幂等） | 手工 `bun run db:migrate` |
| 升级 | 改 `STORE_IMAGE` → `pull` + `up -d` | `git checkout <tag>` + build + 重启 |
| 资产 | `<项目名>_assets` 命名卷 | `STORE_ASSET_DIR` 目录 |
| 环境变量 | 同一张表（§2），compose 用 `${VAR:?}` 挡缺项 | `.env.local` |
| 备份 | `docker compose exec db pg_dump` + 卷打包 | §7 的 `pg_dump` / `tar` |

两条路共用同一条原则：迁移只前进、`/api/health` 是存活探针、备份是「库 + 资产」两样。这些写在
§7 / §8 / §9，本节不重复。

## 4. 镜像构建与发布

### 4.1 包地址与 tag 语义

`ghcr.io/keeptrue/sforum-app-store`，由 `.github/workflows/docker.yml` 构建推送。

| 事件 | 产物 |
| --- | --- |
| push `main` | `edge` |
| push `v1.2.3` | `1.2.3` + `1.2` + `latest` |
| push `v1.2.3-rc1` | `1.2.3-rc1`（预发布：不打 `latest`，也不打 `1.2`） |
| 非 semver tag（`vfoo`、`v2`） | `verify-tag` gate 失败，不构建、不推送 |
| pull request | `pr-<N>`，只构建不推送 |

**硬约束：不要推非 semver 的 tag。** `v*` 只是触发条件，tag 本身必须是
`vMAJOR.MINOR.PATCH[-prerelease]`（`verify-tag` 用
`^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$` 判），否则那个 job 直接失败，
`build` / `smoke` / `note-arm64` 全部跳过，一个镜像都不会出。理由在 `latest`：镜像 tag 与
`latest` 都从 tag 名派生，格式不对时 `latest` 会落到任意 commit 上；gate 与
`flavor: latest=auto` 一起把 `latest` 限死在正式版 semver 上。

预发布只出一个 tag 是同一套机制的另一半：`type=semver` 遇到 prerelease 会忽略 pattern、统一
回落到 `{{version}}`，所以 `{{major}}.{{minor}}` 那条规则对它不生效（`metadata-action` v5
`meta.ts:186-196`）。`type=ref,event=tag` 已从 tags 列表里删掉——它在 `flavor: auto` 下会硬编码
`latest=true`，正是「非 semver tag 顶掉 `latest`」的来源。

镜像里的 `STORE_BUILD_VERSION` 取构建时的 ref：`refs/tags/v*` → tag 名；`refs/heads/main` →
`edge`（**手动 `workflow_dispatch` 在 main 上跑的也是 `edge`**）；其余 ref → `dev`。
`STORE_BUILD_COMMIT` 是 commit sha；`/api/health` 会回显这两个值，用来确认线上跑的是哪个。

### 4.2 触发条件与验证

- 触发：push `main`、push `v*` tag、`pull_request`、`workflow_dispatch`。**`v*` 触发不等于会被
  构建**：tag 必须是 semver，否则 `verify-tag` 直接失败（§4.1）。
- 推送 `v*` 还会触发 `release.yml`：按 `linux/amd64`、`linux/arm64`、`darwin/arm64`、
  `darwin/amd64` 四个平台重建插件后端、刷新摘要、跑宿主闸并打包，把 ZIP、SBOM 与
  `SHA256SUMS` 挂到该 tag 的 GitHub Release。`workflow_dispatch` 只做校验与构建，不创建
  Release。标签版本必须与 `plugin/plugins/sforum.store/sforum.extension.json` 的 `version`
  一致，否则 verify 直接失败。
- 同一 ref 的构建串行（`concurrency: docker-<ref>`）：PR 允许取消前一次，`main` 与 tag 不取消，
  保证 tag 一定出镜像。
- 平台：推送时 `linux/amd64,linux/arm64`（arm64 走 QEMU 交叉构建）；PR 只构 `linux/amd64` 且不推送。
- 权限：`contents: read` + `packages: write`，用 `secrets.GITHUB_TOKEN` 登录 GHCR，不需要另配 PAT。
- 构建之后跑 `smoke` job：用同一份 Dockerfile 构一个 amd64 本地镜像，起真实 Postgres，跑
  `migrate` → `web` → `worker`，断言 `/api/health` 200 且无 `configError`、首页 200、worker
  打出 `[worker] ready`。**「构建成功」不算能用，这条才算。**
- **arm64 没有实跑证据**：smoke 只在 amd64 上执行，arm64 是交叉构建产物。workflow 里的
  `note-arm64` job 把这句话写进 run summary，免得有人以为 arm64 验证过。

### 4.3 拉取与可见性

- 包可见性随仓库：本仓当前是**私有**的，GHCR 包默认也私有 —— 匿名拉取会被拒（实测
  `docker manifest inspect ghcr.io/keeptrue/sforum-app-store:edge` → `unauthorized`）。
  拉取前先 `docker login ghcr.io`，token 需要 `read:packages`。仓库转公开后到
  GitHub → Packages 里核对 Visibility，再决定是否保持私有。
- 首次构建（2026-10-27，main `cdcf0f6`）：`build` 成功并推送了 `edge`。同一次运行里
  `smoke` / `note-arm64` 被跳过 —— 非 tag 事件下 `verify-tag` 是 skipped，而 skip 会沿
  `needs` 链传染，两条 job 没写显式 `if` 就一起被吞了。工作区已给它们加
  `if: !cancelled() && needs.build.result == 'success'`，**待推送后下一次运行验证**。
- 私有包要登录：

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
```

token 需要 `read:packages`（经典 PAT）。登录信息落在 `~/.docker/config.json`，
`docker compose pull` 走同一份凭据。

### 4.4 本地构建

```bash
docker build -t sforum-app-store:local .
STORE_IMAGE=sforum-app-store:local bash scripts/docker/bootstrap.sh
```

- 构建期不读任何 `STORE_*` / `DATABASE_URL`：`.dockerignore` 挡掉 `.env*`，CI 也在空环境里构建。
- **构建机要能访问 `fonts.googleapis.com` / `fonts.gstatic.com`**：`src/app/layout.tsx` 用
  `next/font/google`，字体在构建时下载并自托管进产物。断网构建会失败。
- 运行时口径与 CI 一致：`bun --bun next build` + `bun --bun next start`；不引
  `output: "standalone"`（v1 走完整 `.next` + `node_modules`，与 CI 冒烟同一路径）。
- 单镜像多角色：`web` / `worker` / `migrate` 是同一份产物，只差 `command`。
- 可选冒烟：`scripts/docker/smoke.sh` 对同一个镜像依次跑 `migrate` → `web` → `worker`，三个角色
  都在专用 bridge 网络 `store-smoke-net`（`SMOKE_NETWORK` 可改）里，**不发布宿主端口**，所以宿主
  的 4000 被 dev server 或已有 stack 占着也照样能跑。它只需要一个宿主可达的 Postgres：
  `DATABASE_URL` 里的 `127.0.0.1` / `localhost` 会被脚本改写成 `host.docker.internal`
  （配 `--add-host=host.docker.internal:host-gateway`），请求也从容器里发。

```bash
docker run -d --name smoke-db -e POSTGRES_USER=store -e POSTGRES_PASSWORD=store \
  -e POSTGRES_DB=store -p 5432:5432 postgres:17-alpine
DATABASE_URL=postgres://store:store@127.0.0.1:5432/store IMAGE=sforum-app-store:local \
  bash scripts/docker/smoke.sh
docker rm -f smoke-db
```

几点注意：

- `POSTGRES_USER` / `POSTGRES_DB` 不能省：`postgres:17-alpine` 只给口令时建的角色是 `postgres`，
  而脚本默认连 `store`，会报 `password authentication failed for user "store"`。
- 宿主 5432 被占就换映射（`-p 15432:5432`）并同步 `DATABASE_URL` 的端口。
- 也能直接对 GHCR 镜像跑（本地没有会自己 `docker pull`）：
  `IMAGE=ghcr.io/keeptrue/sforum-app-store:edge DATABASE_URL=… bash scripts/docker/smoke.sh`。
- 脚本自己建 / 删 `store-smoke-net` 与 `store-smoke-web` / `store-smoke-worker`，不动
  `docker compose` 起的那套。
- macOS / Windows 上 `--add-host …:host-gateway` 与 `host.docker.internal` 的可用性**未验证**。

## 5. 首次启动（手工部署）

```bash
bun install --frozen-lockfile
bun run db:migrate                 # 需要 DATABASE_URL（.env.local）
bun run build
bun run start                      # Next + release worker，一条命令两个进程
curl -s http://127.0.0.1:4000/api/health   # {"status":"ok",...}
```

### web 与 worker：一条命令，两个进程

`bun run dev` 与 `bun run start` 都走仓根 `scripts/supervise.ts`：一个终端里起 Next 与 release
worker，输出按子进程加前缀，第一个子进程退出就整组收尾。

| 命令 | 起什么 |
| --- | --- |
| `bun run dev` | supervisor：Next dev + worker（development） |
| `bun run start` | supervisor：Next start + worker（worker 为 production） |
| `bun run dev:stop` | 停掉 web + worker，并清掉 Next dev 锁（`--force` 直接 SIGKILL） |
| `bun run start:web` | 只起 web（多副本 / 排障） |
| `bun run worker` / `bun run worker:prod` | 只起 worker |

supervisor 的行为：

- 输出带 `dev:web |` / `worker  |` 前缀（脚本名右补到等长再拼 ` | `；`start` 那组是
  `start:web   |` / `worker:prod |`），两个子进程的行不会糊在一起。
- **fail-fast**：第一个子进程退出 → 其余子进程（按 session 枚举出来的成员）收 SIGTERM，5 秒
  （`SHUTDOWN_GRACE_MS` 常量，不可配）后仍在的补 SIGKILL，命令整体退出。旧写法
  `bun run --parallel --no-orphans` 做不到这一步：实测等满 8 秒兄弟进程仍在跑，worker 永不退出时
  终端就一直挂着。
- `Ctrl+C`（SIGINT）、SIGTERM、SIGHUP 与「某个子进程先退出」走同一条收尾路径；退出码分别是
  `130` / `143` / `129`，子进程先退出时用它自己的退出码。
- 运行态写 `tmp/supervise.json`：`{supervisor, startedAt, children: [{label, pid, script}]}`，
  `pid` 是子进程（**session leader**）的 pid。`bun run --filter` 会把真正的脚本放进**新的进程组**、
  但继承这个 session，所以 `dev:stop` 读它之后是按 session 找成员，不是按进程组。`tmp/` 不入库。

**没有 worker** 时，GitHub webhook 只会入队不处理，release 永远不会同步；合并后不会再出现
“只起了 web”的情况。

多副本生产不要在每个副本上跑 `start`（每个副本都会起一个 worker）；用 `start:web` + 一个
`worker`。合并的代价是 web 与 worker 同生共死；需要独立重启时也用 `start:web` + `worker`。

#### dev 起不来：Next dev 锁与 `bun run dev:stop`

Next 16.4.3 的 `experimental.lockDistDir` 默认是 `true`（`next/dist/server/config-shared.js:287`），
`next dev` 启动后对 `service/.next/dev/lock` 持一把独占 flock，文件内容是
`{pid, port, hostname, appUrl, startedAt}`。拿锁排在 `listen` **之后**：

1. 进程先绑上 4000 并打印 `Ready`；
2. 然后才去拿锁；
3. 拿不到就打印 `Another next dev server is already running.`（附 `- PID` / `- Local` / `- Dir`）
   并 `exit 1`。

所以「端口空着却说 already running」不矛盾：端口是新进程刚 listen 的，锁还在上一个进程手里。
判断只有一条——`service/.next/dev/lock` 在不在、里面的 `pid` 还活着没有、以及它是不是**本仓库**
的 dev（`cwd` 指向 `service/`）。

**不要照 Next 的提示 `kill <pid>`。** 那个 pid 是 `next-server`（`ps` 里显示
`next-server (v16.4.3)`）；事故里照提示杀了三次，锁一次都没释放。收尾要落到 CLI 那一层。

停机用：

```bash
bun run dev:stop            # 停 web + worker，并清掉锁
bun run dev:stop --force    # 同上，直接 SIGKILL
```

`dev:stop` 走三条路径，都收完才动锁：

1. `tmp/supervise.json`：先 SIGTERM supervisor（它自己会按 session 收尾），再对 session 里仍属于
   本仓、命令行匹配的成员 + 进程树补刀——`next-server` 会被 reparent 到 init，父链断了，只有
   session 还认得它；`kill` 掉根 `bun run dev` 之后以 PPID=1 存活、继续占着 4000 的 `next-server`
   就落在这一步。
2. `service/.next/dev/lock`：覆盖「supervisor 已经被杀、只剩 next-server」的情况。锁 pid 先过归属
   证明（`cwd == realpath(service/)` + 命令行是 next-server 形态），不过就只报告、跳过；过了再看
   父进程：父进程也过证明（next-dev CLI 形态）就 SIGTERM 父进程（`next dev` 会自己收子进程），
   否则 SIGTERM 锁 pid；父进程先退了而锁 pid 还活着时再打一次。锁指向别的 checkout、或命令行里
   只是含 `next` 的无关进程，一律不动。
3. 端口：只在锁不可读或缺失、而 `:4000` 还有监听时启用。拿监听者 pid，先证明它属于本仓——
   `cwd == service/` 且命令行是 `next-server` / `.bin/next` / `next/dist/bin/next` /
   `src/worker.ts` 之一——才连同它的 session 一起收；证明不了就只报告。**另外**，如果本仓库已经
   没有任何 dev 进程、`:4000` 也空闲，读不出内容的锁同样删掉（否则坏锁会让 `dev:stop` 永远
   exit 1）。预检本身**绝不删**它。

SIGTERM 宽限 10 秒，之后 SIGKILL；`--force` 直接 SIGKILL。**端口本身不是杀的依据**：路径 ③ 只在
锁不可用、且监听者的 `cwd` 与命令行都证明是本仓 dev 时才动手，证明不了就只打印占用者。确认锁里的
pid 已经死了**、并且锁里的 port 上没有本仓库的 next 仍在监听**，才删锁文件——flock 挂在 inode
上，CLI 若逃出 session 仍可能握着同一个 inode，删文件名只会让第二个 dev 锁到一个新 inode、两个
进程同时写 `.next/dev`。退出码 0 表示本仓库的 dev 进程都已停止、`:4000` 空闲、
`tmp/supervise.json` 已删除（没有活着的 supervisor 才删）。**外部锁是例外**：锁指向的进程不属于
本仓库（`cwd` 不是 `service/`，或命令行不是 Next）时，`dev:stop` 不动它，退出码仍为 0，但
`service/.next/dev/lock` 会保留——确认没有 dev 在服务后手工删即可（下次 `bun run dev` 也会重写
它）。反过来，锁的属主已退出、但锁里的 port 上仍有本仓库的 next 在监听时，锁不会被删，退出码是 1。

锁是陈旧的（`pid` 已经不在了）不用手工处理：supervisor 起 dev 之前会预检，看到「pid N 已经不
存在」就删掉文件再启动（删之前还看锁里的 port：本仓库的 next 仍在那上面监听就只告警、先不删）。
只有「`pid` 活着 + 命令行像 Next + `cwd` 是 `service/`（realpath 比较，symlink 检出也认）」三条
同时成立，才算**本仓库的** dev 在跑：这时它**不启动**，打印一份报告（pid 与进程名、appUrl、
启动时间、`:4000` 是在服务还是正在退出、两条下一步：`dev:stop` / `dev:stop --force`）并
`exit 1`。命令行不像 Next（PID 复用）、或像 Next 但 `cwd` 不是本仓库（另一个 checkout）都算
`unknown`：只告警、不删、**照常启动**，`dev:stop` 也不动它（exit 0），报告写的是「确认没有 dev
在服务后，手工删掉锁再启动」。锁文件读不出来同样只告警、不删、照常启动。

手工兜底（`dev:stop` 也没有的时候）：杀 `next dev` 的父进程，实测 213 ms 干净退出、锁随之释放。
不要用 `rm -rf .next` 来解锁——清 `.next` 是另一个症状（每个请求都重编译）的处理，见上面
「重启 `next dev` 时先清 `.next`」，顺手清掉会连缓存一起丢。

win32 上 supervisor 不 `detached`（没有 session 可枚举），收尾走 `child.kill()` +
`taskkill /PID <pid> /T /F`；判活仍是 `kill(pid, 0)`，锁清理逻辑不变。这条分支**未实测**
（本机只有 Linux）。

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

## 6. GitHub App 注册（约 10 分钟）

分两半：先在 GitHub 上建 App，再把它的凭据填进后台。**没有 env 步骤，也不需要重启**——
保存后 web 与 worker 各自在 15 秒内读到新配置（进程内缓存）。

### 6.1 在 GitHub 上建 App

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

### 6.2 在后台填写

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

## 7. 备份与恢复

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

## 7.5 安装闸门（下载登录要求）

商城可以把「签发下载链接」这一步改成需要商城账号。目录、详情与搜索**始终匿名**可浏览；
被挡住的是**拿链接**，不是字节——签名链接本身仍是 30 分钟的 bearer。

### 开关

运行时设置，不是重启项：

- 后台 `/<STORE_ADMIN_PATH>/settings/general` →「下载登录要求」：跟随环境变量 / 匿名签发 /
  需要商城账号。保存即生效（当前进程下一个请求），其他进程 15 秒内收敛。
- 环境种子 `STORE_DOWNLOAD_AUTH_MODE`，默认 `anonymous`。行里的值优先于种子；留空即跟随种子。
- `/api/health` 回报 `downloadAuthMode` 与 `downloadAuthModeSource`（`database` / `env`），
  切换后用它确认每个进程都跟上了。

### 切到 `account_required` 之前

1. **先把所有站点的 `sforum.store` 升级到支持登录授权的版本**（清单 `sforumVersion` 会拦下
   不满足的 core）。旧插件不带令牌，会收到 401 `login_required`，页面只能显示「商城暂时不可用」。
2. 确认后台配置的商城地址（`publicUrl`）与插件里填的商城地址**同源**：授权页 URL 由商城地址
   拼成，插件会校验 origin，不一致时连接条会报错。
3. 论坛侧要能登录：授权页复用论坛 OAuth2 会话，论坛没登录会先跳论坛登录。

### 切换后发生什么

- 插件页第一次打开会显示连接条：点「连接商城」→ 新标签打开商城的 `/connect/{id}` → 管理员用
  论坛账号批准 → 插件后端兑换到一个 **30 天**的账号令牌并写进宿主的加密 secret 设置
  （`sforum.store.account_token`，设置页只显示「已配置」）。之后 30 天内安装都不再要求登录。
- 浏览器前台点「下载（需登录）」→ 302 到论坛登录 → 回到同一个文件 → 302 到签名地址。
- 审计：`auth.install_request.approved` / `auth.install_token.issued` /
  `auth.install_token.revoked` / `download.issued`（账号级签发才有）/
  `settings.download_auth_mode.changed`。令牌、verifier 与签名 URL 不进审计、不进日志、不进响应。
- 令牌是**论坛级**：同一论坛的所有管理员共用，审计记「哪个商城账号授权了这台论坛」，不记
  「哪个管理员点了安装」。要按管理员归属需要 core 的 actor 上下文（Tier 2，未做）。

### 回滚

后台切回「匿名签发」（或把种子改回 `anonymous` 并重启）即可，**不需要重新部署**：旧插件立刻
恢复；已经签发的令牌保留到过期或手动撤销（插件页「断开连接」，或等 30 天）。已发出的签名链接
不受影响——它们本来就是 30 分钟的 bearer。

回滚演练记录见 `knowledge/sessions/2026-10-27-download-auth-gate.md`。

## 8. 升级与回滚

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

## 9. 健康与告警

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
