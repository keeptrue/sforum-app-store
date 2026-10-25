# 运行时设置进后台（`store_settings`，env 退为种子）

Status: accepted
Date: 2026-10-25

## 背景

`STORE_PUBLIC_URL` 是这套部署里最容易被改错、也最容易改不起的一个值：

1. **它决定的东西太多。** OAuth `redirect_uri`、登录成功/失败重定向、`isSameOrigin` 的比较
   基准、cookie 名与 `Secure`、下载短链、GitHub webhook / Setup URL 全部由它派生。错一位的
   表现不是报错，而是「点登录没反应」——`sessions/2026-10-25-tunnel-public-url-mismatch.md`
   记录的就是这个：隧道换了、值没换，回调、写操作、dev 静态资源三处同时断。
2. **改它要重启两个进程。** `lib/config.ts` 是模块级 `cached`，web 与 worker 是两个进程。运营
   只想把地址从 `http://127.0.0.1:4000` 换成隧道域名，代价是一次构建外的重启，而且改错了没有
   任何界面能看出来「现在到底生效的是哪个地址」。
3. **限流参数同样卡在 env。** 被刷的时候想临时收紧 `download-ip`，只能改 env + 重启，等于在最
   需要它稳的时候重启它。
4. **下载有效期过去没有配置入口。** 本轮之前的 `.env.example` 里没有对应变量，后台也没有这一项；
   现在它是 `store_settings.download_ttl_seconds`（默认 1800 秒，范围 300–86400）。

同期 `github_app_config` 已经把「运行时配置进库、后台是唯一写入口、15 秒 TTL + 保存即失效」
这条路走通（`2026-10-25-github-app-config-in-console.md`），issuer 更早也是这条路
（`2026-10-25-admin-local-identity.md`）。这次是同一模式的第三次应用。

## 决定

### D1 单行表，env 只作种子

- 表：`store_settings`（迁移 `service/drizzle/0010_store_settings.sql`），单行 `id='default'`，
  列 `public_url` / `download_ttl_seconds` / `rate_limits`(jsonb) / `updated_by_admin_id`
  （FK `admin_accounts`，`on delete set null`）+ `created_at` / `updated_at`；
  `store_settings_singleton_idx` 用 `(true)` 表达式唯一索引兜住第二行。
- **只钉住运营真正改过的值**：`public_url` 等于 `STORE_PUBLIC_URL` 时写 `NULL`，不把种子复制
  进行里——否则改一次有效期就会顺手把地址钉死，之后改 env 不再生效。
- **解析顺序固定：行 > env 种子。** `STORE_PUBLIC_URL` 仍然启动必填（`getConfig()` 缺它抛
  `ConfigError`），但类型改名为 `publicUrlSeed`，语义变成「恢复默认时的落点」：后台「恢复默认」
  或 `--clear` 删行后回到它。
- 只搬三样（Tier A）：`publicUrl`、`downloadTtlSeconds`（默认 1800 秒，范围 300–86400）、六个
  限流通道（`login` / `admin-login` / `submit` / `download-ip` / `download-token` / `repo`，
  格式 `"<次数>/<秒>"`，留空=继承 env/内置默认）。
- **留在 env 且明确不进后台**：`STORE_SESSION_SECRET`、`STORE_DOWNLOAD_SECRET`、
  `STORE_SECRET_KEYS`、`DATABASE_URL`、`STORE_ASSET_DIR`（签名根与启动期依赖，轮换是另一个
  特性）；`STORE_ADMIN_PATH`（改完当前 URL 立即 404，自锁）；`STORE_ADMIN_SETUP_TOKEN`
  （一次性授权面）；`sessionTtlSeconds` / `adminSessionTtlSeconds` / `stateTtlSeconds`
  （安全策略常量）。`STORE_RATELIMIT_*` 保留为默认值层。
- **存了但校验不过的值是「忽略」，不是「致命」。** 手改坏的 `public_url` 让解析回退种子并把原因
  放进 `warnings`，页面显示出来；因为一行坏列让登录路由 500，会连那个能修它的页面一起打死。

### D2 异步快照 + 15 秒 TTL + 保存即失效

- 唯一读口 `service/src/lib/settings/runtime.ts` 的 `getRuntimeConfig(db)`：进程内缓存 15 秒，
  命中时按 `updated_at + public_url` 算签名，签名不变复用同一个 `RuntimeConfig` 对象。
- 后台保存（`saveStoreSettings`）与重置（`clearStoreSettings`）都先 `invalidateRuntimeConfig()`
  再用 `{ fresh: true }` 回读，所以 **PUT 的响应体就是「已经生效」的视图**，不是「你提交的
  值」；设置页与 `/api/health` 也走 `fresh`。
- 与 `github_app_config` 同一套范式、同一套理由：web 与 worker 是独立进程，配置必须能在不重启
  的前提下收敛；缓存只负责省掉每请求一次单行 select。
- 不做 LISTEN/NOTIFY 跨进程推送（见「放弃的方案」）。

### D3 用类型改名逼编译器找齐调用点

`publicUrl` 在二十多个调用点被当作「真相」使用（OAuth start/callback/logout/refresh、后台 guard
的同源基准、下载短链、GitHub webhook/setup/install、moderation 与 products 的绝对链接、
`/api/health`）。所以 `StoreConfig.publicUrl` 改名为 `publicUrlSeed`：改名后每个旧调用点都编译
失败，必须显式回答「我要生效地址，还是我只要种子」。同批把 cookie 形状收进
`getCookieShape(db)`，不再有人从 config 里直接读 `Secure`。

### D4 防自锁三件套

改地址这个动作本身就带着「把自己关在门外」的能力，所以三层都做了：

1. **同源双判据。** `isSameOrigin` 接受「配置的 publicUrl origin」**或**「请求自身的 origin」
   （`x-forwarded-host` / `Host` + `x-forwarded-proto`）。浏览器无法伪造 `Origin`，CSRF 强度
   不变；收益是刚改完地址（或代理还没就绪）时，后台自己的写操作不会被 403 锁死。
2. **两个确认闸门**（`PUT /api/admin/settings`，都是 409，且只在**地址确实要变**时触发——只改
   有效期不会被拦）：`confirm_origin_change`——新地址的 origin 与本次请求 origin 不一致，需要
   `confirmOriginChange: true`；
   `confirm_insecure_transition`——当前请求是 http 而新地址是 https，需要
   `confirmInsecureTransition: true`（`__Host-` cookie 在 http 下写不进去，TLS 没就位时保存
   等于登出且登不回来）。
3. **CLI 逃生口。** `bun run settings:public-url -- --show | --set <url> | --clear`
   （`service/scripts/settings-public-url.ts`）：后台进不去时用，`--clear` 删行回到种子。

### D5 cookie 形状跟随生效地址，不跟随请求协议

cookie 名与 `Secure` 由**生效地址的协议**决定（https → `__Host-store_*`），于是 http↔https 切换
会让所有会话（含管理员）失效、必须重新登录。这是刻意的：按请求协议派生等于允许在 http 下拿到
非 `Secure` 的会话 cookie，那是给降级攻击开口。

## 放弃的方案

- **env 优先、数据库兜底（或反过来）。** 两个来源意味着「改了没生效」永远要排查两处，且回退路径
  会被误用成灰度手段。与 `github_app_config` 的「一个来源」口径也不一致。
- **按请求协议派生 cookie 名与 `Secure`。** 见 D5：那会让「谁在 http 上访问」决定会话 cookie
  的安全属性。
- **一次性把全部 env 搬进库。** 签名根（`STORE_SESSION_SECRET` / `STORE_DOWNLOAD_SECRET`）轮换
  需要双密钥兼容窗口，是另一个特性；keyring 进库等于把密文和密钥放在一起（同
  `2026-10-25-github-app-config-in-console.md`）；`STORE_ADMIN_PATH` 改完自锁；
  `STORE_ADMIN_SETUP_TOKEN` 是一次性授权面，放进后台等于给已登录管理员再开一个注册口；会话与
  state TTL 是安全策略，做成可配就是给运营一个把会话寿命设成十年的开关。
- **LISTEN/NOTIFY 跨进程推送。** 多一条长连接、多一种失败模式，只买到几秒收敛；当前 15 秒窗口
  对运营动作没有实际影响。
- **`store_settings(key, value)` 多行 key-value 表。** 读一次要 N 行，「PUT 全量替换三项」的
  语义也没法原子表达；单行 jsonb 让「保存了什么」和「生效了什么」是同一个对象。
- **把限流覆盖也做成 env 字符串（`STORE_RATELIMIT_OVERRIDES=login=5/300,...`）。** 又回到
  「改 env 重启」，正是这次要消掉的成本。

## 代价与重开条件

- **多副本 15 秒窗口。** 保存它的进程下一个请求即生效；其它副本与 worker 最多 15 秒。这段窗口
  里旧副本仍用旧地址（含旧 cookie 形状），协议切换时表现为「这一台掉登录、那一台还在」。
- **协议切换全员重登**，管理员也一样；这是 D5 的直接代价。
- **旧短链只在旧地址仍可路由时有效**：token 不绑域名，链接里的 host 是签发时的地址。
- **每进程每 15 秒多一次单行 select**（可接受，两条主要路径本来就要读库）。
- **「种子」这个概念有学习成本。** env 里还留着一个必填、但只在没有行时才决定行为的地址，文档必须每次
  都说清楚（`service/.env.example`、`docs/deployment.md`、`docs/oauth-setup.md`、
  `docs/github-app.md` 都已改口径）。
- 重开条件：如果将来要按通道/按租户多套限流，或要热轮换签名根，单行表与「env 只作种子」的口径
  都要重做；若真出现「多副本收敛窗口导致事故」，再上 LISTEN/NOTIFY 或版本号轮询。
