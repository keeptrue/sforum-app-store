# 2026-10-25 运行时设置进后台（`store_settings`）

## 结果

对外地址（`STORE_PUBLIC_URL`）、下载短链有效期与六个限流通道从「改 env + 重启 web 与 worker」
变成**后台可改**：新增单行表 `store_settings`，解析顺序是「行 > env 种子」，保存它的进程下一个
请求即生效，其它进程与副本 15 秒收敛。入口 `/<STORE_ADMIN_PATH>/settings/general`
（默认 `/admin/settings/general`），侧栏 **配置 → 系统设置**。取舍见
`decisions/2026-10-25-runtime-store-settings.md`。

为什么值得做：隧道/反代换入口时错配 `STORE_PUBLIC_URL` 的表现是「点登录没反应」，过去只能改
env 重启，而且没有任何界面能回答「现在生效的是哪个地址」
（见 `sessions/2026-10-25-tunnel-public-url-mismatch.md`）。

## 关键实现事实

- **表**：`service/drizzle/0010_store_settings.sql`，单行 `id='default'`，列 `public_url` /
  `download_ttl_seconds` / `rate_limits`(jsonb) / `updated_by_admin_id`（FK `admin_accounts`，
  `on delete set null`）/ `created_at` / `updated_at`；`store_settings_singleton_idx` 是
  `(true)` 表达式唯一索引。
- **只钉改过的值**：保存时若 `publicUrl` 等于 `STORE_PUBLIC_URL`，`public_url` 写 `NULL`；只改
  有效期不会把地址一起钉死。
- **解析顺序**：`store_settings` 行 > env 种子。`STORE_PUBLIC_URL` 仍启动必填
  （`lib/config.ts` 的 `requireEnv`），但字段改名为 `publicUrlSeed`——它现在是「恢复默认」的
  落点，不是真相。
- **坏值降级**：库里存了但校验不过的 `public_url` / 限流值被**忽略**并写进 `warnings`（页面显示），
  不让登录路由因为一行坏列 500。`lib/settings/validate.ts` 是表单与运行时共用的同一套校验。
- **缓存**：`lib/settings/runtime.ts` 的 `getRuntimeConfig(db)`，15 秒进程内缓存，签名
  `updated_at + public_url` 不变则复用同一对象；`saveStoreSettings` / `clearStoreSettings` 先
  `invalidateRuntimeConfig()` 再以 `{ fresh: true }` 回读，所以 `PUT` 的响应体是**已生效**的视图。
  设置页与 `/api/health` 也走 `fresh`。
- **派生地址只有一个源**：`sforumCallbackUrl` / `githubWebhookUrl` / `githubSetupUrl` 都吃
  `runtime.publicUrl`，设置页把三者显示成可复制文本，运营不用手打。
- **cookie 形状**：`getCookieShape(db)` 是唯一来源，名字与 `Secure` 跟随生效地址的协议
  （https → `__Host-store_*`）。协议一换，所有会话（含管理员）作废、必须重新登录——刻意的，
  不按请求协议派生。
- **两个 409 闸门**（`PUT /api/admin/settings`）：`confirm_origin_change`（新 origin ≠ 请求
  origin，需 `confirmOriginChange: true`）、`confirm_insecure_transition`（请求 http 而新地址
  https，需 `confirmInsecureTransition: true`）。
- **同源双判据**：`lib/auth/http.ts` 的 `isSameOrigin` 接受配置 origin **或**请求自身 origin
  （`originFromHeaders`：`x-forwarded-host`/`Host` + `x-forwarded-proto`）。跨站页面伪造不了
  `Origin`，CSRF 强度不变；改地址后后台自己的写操作不再 403。
- **限流覆盖**：`rate_limits` 存 `{channel: "次数/秒"}`，留空=继承 env/内置默认；
  `admin-login` 的下限（`ADMIN_LOGIN_MIN_LIMIT = 3`）在**两层**都成立：后台保存时拒绝，
  env 层在 `loadRateLimitRules` 里钳到 3 并打一条 `[ratelimit] … clamped` 警告。所以「把自己
  锁在后台外面」没有可配置的路径（`parseRuleSpec` 本身仍接受任意正数，它是通用解析器）。
- **审计**：`admin.settings.updated`（details 只含变更键的 from/to）、`admin.settings.reset`；
  `audit_log.target_type` 新增 `store_settings`，审计页筛选项叫「系统设置」。
- **CLI**：`bun run settings:public-url -- --show | --set <url> | --clear`
  （`service/scripts/settings-public-url.ts`，根目录与 `service/` 都有同名脚本）。`--set` 不写
  `updated_by_admin_id`，不会抹掉后台最后一次修改人。
- **`/api/health`**：新增 `publicUrlSource`（`database` | `env`）、`settingsUpdatedAt`、
  `configWarning`；数据库不可达时仍 200，回退种子并给 `configWarning`。契约
  `contracts/store-api.yaml` 的 `Health` 已同步。

## 改动清单

**新增（代码，本轮未由文档轮改动）**：`service/drizzle/0010_store_settings.sql`、
`service/src/lib/settings/{runtime,service,validate}.ts`（+ `routes.test.ts` / `service.test.ts` /
`validate.test.ts`）、`service/src/app/[adminPath]/(console)/settings/general/page.tsx`、
`service/src/components/admin/store-settings-form.tsx`、`service/src/app/api/admin/settings/route.ts`、
`service/scripts/settings-public-url.ts`。

**修改（代码，同上）**：`db/schema.ts`（`storeSettings`）、`lib/config.ts`（`publicUrlSeed`）、
`lib/auth/http.ts`（`isSameOrigin` / `originFromHeaders`）、`lib/auth/cookies.ts`、
`lib/admin/{cookies,guard,system,audit}.ts`、`lib/ratelimit/enforce.ts`、
`lib/download` 相关调用方、`lib/github/app-config.ts`、`lib/moderation/service.ts`、
`lib/products/service.ts`、`app/api/{health,auth/sforum/*,auth/logout,auth/refresh,
admin/password,github/install/start,github/setup,v1/download-urls}/route.ts`、
`components/admin/{audit-filter-form,nav-items}.ts(x)`、`contracts/store-api.yaml`、
`service/package.json` + 根 `package.json`（`settings:public-url` 脚本）。

**本次文档轮改动**：`service/.env.example`（`STORE_PUBLIC_URL` 改为种子语义、限流段标注可被
后台覆盖并补上漏掉的 `STORE_RATELIMIT_ADMIN_LOGIN`、新增「运行时设置」段指向
`/settings/general`）、`docs/deployment.md`（必需/可选表口径、反向代理小节改为按生效地址推导、
新增「改对外地址（后台即可，不用重启）」、`/api/health` 字段、GitHub 注册两格地址）、
`docs/oauth-setup.md`（前置条件与失败表两处口径）、`docs/github-app.md`（三个派生地址与
「保存即生效」）、`docs/README.md`（`deployment.md` 一行简介）、
`knowledge/decisions/2026-10-25-runtime-store-settings.md`、本交接、
`knowledge/index.md`（Latest Handoff + 关键约束速查）、`knowledge/decisions/README.md`（索引一条）。

## 验收证据

**代码侧（实施轮实测）**

- `cd service && bun test --parallel=1` → **538 pass / 0 fail / 50 files**（新增
  `lib/settings/{validate,service,routes}.test.ts` 与 `rules.test.ts` 的 env 钳制用例）。
- `bunx tsc --noEmit` → 无输出（通过）。
- `bun --bun next build` → 成功（`/api/health`、`/api/admin/settings` 等全部按动态路由产出）。
- 迁移 `0010_store_settings.sql` 已在 dev 库执行：`store_settings` 表 + `store_settings_singleton_idx`。

**端到端「保存即生效」（dev server，未重启进程）**

1. 后台把「下载链接有效期」改成 45 分钟、「论坛登录」限流改成 `4/120`，点「保存并立即生效」
   → Toast「已保存，当前进程已生效」，页脚出现「上次修改：… UTC · root」。
2. `GET /api/health` 立刻变成 `publicUrlSource: "database"` 且带 `settingsUpdatedAt`。
3. 连打 5 次 `GET /api/auth/sforum/start` → `307 307 307 307 429`：第 5 次被新限流挡住。
4. `POST /api/v1/download-urls`（`search-site` / `linux / amd64`）→ `expiresAt` 距当前 **45 分钟**。
5. 点「恢复默认」→ 行被删除，`/api/health` 回到 `publicUrlSource: "env"`、`settingsUpdatedAt: null`，
   `audit_log` 里依次是 `admin.settings.updated` → `admin.settings.reset`。

**渲染证据**（`tmp/` 未入库）

- `tmp/settings-general-1633x810.png`（1633×810）、`tmp/settings-general-390x844.png`（390×844）。
- 手机宽度下「生效来源」badge 会换到输入框下一行，不挤压地址值（首版是并排挤掉一半，
  已改为 `flex-wrap` + `basis-[16rem]`）。

**文档轮亲自核对过的代码事实**：迁移 SQL 与索引、`runtime.ts` 的 15 秒 TTL 与签名复用、
`service.ts` 的两个 409 与写后 `fresh` 回读、`validate.ts` 的 TTL 区间（300–86400）、
`isSameOrigin` 的双判据、`health/route.ts` 的新字段与回退分支、
`scripts/settings-public-url.ts` 的三个动作、六个限流通道与 env 映射、`store_settings` 在
`AUDIT_TARGET_TYPES` 与审计筛选项里的登记、契约的 `publicUrlSource` / `settingsUpdatedAt` /
`configWarning`。

## 未验证

- **多副本 / web 与 worker 的 15 秒收敛**：代码路径明确（各自进程内缓存 + 写后失效），但没有做
  双进程实测。验证方式：起 web + worker，后台改地址，观察 worker 侧日志与旧副本行为在 15 秒内
  变化。
- **真实反代下的地址切换**：`http → https`（cookie 前缀切换导致全员重登）只在本地 dev 库验证过
  逻辑，没有在真实域名 + 反代上演练。验证方式：按 `docs/deployment.md`「改对外地址」checklist
  在隧道域跑一次，核对 `/api/health` 的 `publicUrl` / `publicUrlSource` / `sessionCookie`。
- **旧短链在旧地址停解析后的行为**：按「token 不绑域名、host 来自签发时地址」推断为死链，
  未实测。
- **两个 409 闸门的完整浏览器往返**：服务端错误码与字段名有单测与路由测试覆盖；表单侧实现了
  「确认结果累积」（新主机 + 换协议要连着确认两次，第一次的答案不能被第二次冲掉），但**没有**
  在浏览器里真的把 `publicUrl` 改成另一个 origin 走完两次确认——那会把 dev 库的对外地址改掉。
  验证方式：起一个一次性库，把地址改成本机另一个端口，观察两次 409 → 两次确认 → 生效与
  `origin 不一致` 告警条。

## 下一步

1. 补一次双进程收敛实测与一次真实域名切换演练（含论坛 OAuth redirect URI、GitHub App 的
   Webhook / Setup 两格、插件 `sforum.store.catalog_base_url`）。
2. 后台「系统设置」页的告警条（生效地址 ≠ 当前访问 host）与两个 409 闸门的完整浏览器往返，
   见上面「未验证」第一条。
3. 若确认 15 秒窗口在真实多副本下会造成可见问题，再评估 LISTEN/NOTIFY（决策记录里写了重开条件）。
