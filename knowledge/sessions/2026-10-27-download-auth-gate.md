# 商城安装登录闸门（P0–P7 落地交接）

日期：2026-10-27
任务书：`plans/2026-10-27-download-auth-gate.md`（P0–P7 全部按阶段出口走完）
决策：`decisions/2026-10-27-plugin-own-secret-write.md`（core 侧，SForum 仓）

## 结论

**商城侧的闸门已经能跑**：`download_auth_mode` 默认 `anonymous`（不切与今天逐字节一致），
切到 `account_required` 后签发下载链接需要商城账号；插件页可以「连接商城」，令牌写进宿主
加密的 secret 设置，30 天内安装不再要求登录。

**没有发版，也没有切换**。两件事等操作者拍板：

1. **core 发版号与推送**：`SecretService.Put/Clear` 已在 SForum 仓的分支
   `feat/plugin-own-secret-write`（worktree `../SForum-auth-gate`，提交 `600fa68e6`）。
   插件的 `sforumVersion` 仍是 `>=3.0.17`、`ci.yml` 的 SForum checkout 仍是
   `e753c72b06e45da50d25326c049c51312f887046`——两者必须**同批**移动到含 `Put` 的 core，
   在那之前插件包发不出去（本机用 `GOWORK=tmp/go-workspace/go.work` 指向 worktree 才能编译）。
2. **`download_auth_mode` 切 `required`**：先升级所有站点的插件，否则旧插件 401。

## 各阶段落地

| 阶段 | 内容 | 证据 |
| --- | --- | --- |
| P0 | 读契约/宿主 API、建分支、跑基线 | `bun run test` 826 pass / 70 files；typecheck 0；Go SettingsLifecycle + HostAPI ok |
| P1 | core `SecretService.Put/Clear`（proto + handler + `HasSecretField`/`PutSecret` + 文档） | `proto.sh check` 无 diff；HostAPI/SettingsLifecycle/Extensions 全绿；commit `600fa68e6`（SForum 仓） |
| P2 | 商城 auth：迁移 `0015_install_auth`、`lib/install-auth`、六个 `/api/v1/auth/*`、`/connect/{id}` | `db:migrate` 0；`bun test` 869 pass；commit `bec0c47` |
| P3 | 强制/设置/契约：条件 Bearer、浏览器 302、后台单选 + 警告 + 审计、四个限流通道、契约 | 883 pass；`contract:generate` 无 diff；commit `94905ce` |
| P4 | 插件 Go 后端：`auth.go`、Bearer、401 映射、四条路由、权限收紧、secret 字段 | `go vet`/`go test` 全绿（24 新例）；宿主校验器 manifest OK；commits `182b90f` `8fc8e75` `5046a1b` |
| P5 | 插件页连接条 + 安装闸门 + 双语 + CSS | 前端 210 pass；css 18,890 B / 20,480；commit `91085ec` |
| P6 | 集成构建 | `build.sh` digests 0 updated（可重现）；`manifest:check` / `capabilities:check` 0 |
| P7 | E2E、截图、文档、回滚演练 | 见下 |

## E2E（真实 HTTP + 真实 Postgres + `bun run dev`）

脚本 `/tmp/e2e.ts`（一次性，不入库）跑完这条链：

1. `GET /api/v1/auth/mode` → `account_required`；
2. 匿名 `POST /api/v1/download-urls` → **401 `login_required`**；
3. `POST /api/v1/auth/requests`（S256）→ `id` + `authorize_url`；
4. `POST /api/connect/{id}/decision`（会话 + 同源 Origin）→ 303 `?done=approved`；
5. 轮询 → `approved`；兑换 → 200（`sfo_` 前缀、`download:issue`、30 天）；
6. **重放兑换 → 409 `request_already_used`**；
7. 带令牌签发 → 200 签名 URL；
8. 浏览器入口：无会话 → 302 `/api/auth/sforum/start?redirect=…`；有会话 → 302 签名地址；
9. `/api/v1/auth/me` → 200（账号 `lin`）；`POST /api/v1/auth/revoke` → 204，之后签发 → **401 `token_revoked`**；
10. 审计出现 `auth.install_request.approved` / `auth.install_token.issued` /
    `auth.install_token.revoked` / `download.issued`，**明文令牌在审计里 0 条**；
11. **重启**（`bun run dev:stop` + `bun run dev`）后同一令牌仍能签发 → 200（持久化，不是内存）；
12. 回滚：切回 `anonymous` → 匿名 200、无效令牌被忽略（200）。

### 两个在 E2E 里抓到的真问题

1. **运行时缓存签名漏列**（`lib/settings/runtime.ts`）：缓存签名只含 `updated_at` + `publicUrl`，
   运维直接写库（不碰 `updated_at`）时进程会一直拿旧模式回答——回滚演练第一次就卡在这里。
   现在签名覆盖 `downloadTtlSeconds` / `downloadMode` / `downloadAuthMode` / `rateLimits`，
   并加了用例「a hand-edited row is picked up once the cache window passes」。
2. **dev 进程要重启才认新 schema**：`bun run dev` 起来后改了 `schema.ts`，那个进程里的
   drizzle 表对象仍是旧的，`download_auth_mode` 读不出来（表现为「切了模式没反应」）。
   `bun run dev:stop` + `bun run dev` 即恢复。另：仓库根的 `.env`（docker 用）会被
   `bun run` 自动加载并把 `DATABASE_URL` 指到 `db:5432`，本地起 dev 要用
   `bun --env-file=service/.env.local run dev`。

## 截图（`tmp/`，不入库）

1633×810 直拍；390×844 用同源 iframe（媒体查询按 iframe 视口生效）后裁切。

- 插件连接条三态：`plugin-auth-{blocked,waiting,connected}-{1633,390}.png`
- 商城授权页：`store-connect-{pending,approved}-{1633,390}.png`
- 商城前台「下载（需登录）」：`store-product-login-required-1633.png`、`store-product-login-390.png`

## 未验证 / 已知限制

- **真机宿主链路未跑**：本机没有带登录会话的 SForum 实例，`bridge.installExtension` 的真实
  点击与「连接商城 → 宿主 secret 写入」只在 Go 测试（fake 商城 + fake Host）与页面单测里覆盖。
  验证方式：装到一台 dev 论坛，按 `docs/plugin.md` §4.1 走一遍，看设置页是否显示「已配置」。
- **`install-from-url` 的公网 HTTPS 跳转**仍未验证（沿用上一轮的未验证项）。
- **令牌是论坛级**：审计记授权账号，不记操作者；按管理员归属要 core 的 actor 上下文（Tier 2）。
- **签名链接仍是 bearer**：30 分钟内谁拿到谁能下；闸门拦「拿链接」，不拦字节。
- **旧插件 + `account_required`**：401，页面只能说「商城暂时不可用」——这就是默认保持
  `anonymous` 的原因。

## 下一轮入口

1. 操作者定 core 发版号 → 推送 `feat/plugin-own-secret-write` → 同批改插件 `sforumVersion`
   与 `ci.yml` 的 SForum ref（并重跑 `build.sh`，摘要会变）。
2. 在 dev 论坛上做真机链路（上面「未验证」第一条）。
3. 全部站点升级插件后再切 `download_auth_mode=account_required`，按
   `docs/deployment.md` §7.5 的回滚段落演练一次。
