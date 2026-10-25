# 隧道/反代下登录失效：`STORE_PUBLIC_URL` 错配

Date: 2026-10-25

## 一句话

商城挂在 Cloudflare Tunnel 后面时登录"点了没反应"，不是隧道的问题，是进程仍然认为自己在
`http://127.0.0.1:4000`。所有浏览器可见的绝对 URL 都从 `STORE_PUBLIC_URL` 推导，入口换了、
这个值没换，链路就在三处断开。

## 三个断点（都实测过）

1. **OAuth 授权链**。`sforumCallbackUrl(publicUrl)` 推出
   `http://127.0.0.1:4000/api/auth/sforum/callback`，而 state cookie 设在隧道域。浏览器按域
   隔离，回调读不到它 → `state_mismatch` → `errorRedirect(publicUrl)` 又把人弹回 127.0.0.1。
   `curl -I /api/auth/sforum/start` 的 `Location` 里三个地址全是本机。
2. **同源闸**。`isSameOrigin` 拿 `Origin` 与 `publicUrl.origin` 比：隧道 Origin → 403
   `origin_mismatch`；本地 Origin → 200。已用 `/api/auth/logout` 双向验证。
3. **dev 跨站拦截**。`next dev` 的 `blockCrossSiteDEV` 只放行 `allowedDevOrigins`
   （原先只有 `127.0.0.1`/`[::1]`/`::1`），隧道域下 `__nextjs_original-stack-frame` 403，
   错误覆盖层与 HMR 全黑 —— 前端出错时没有任何可见反馈。

另外发现一个与隧道无关但同场景会踩的坑：`AdminLoginForm` / `AdminSetupForm` /
`AdminPasswordForm` 在**未 hydrate** 时点提交会退化成原生 GET，密码进 URL、Referer 与访问日志。

## 落地清单

- `src/lib/dev-origins.ts`（新）：`resolveAllowedDevOrigins` 从 `STORE_DEV_ORIGINS` 追加 host，
  保留三个 loopback。`next.config.ts` 改用它 —— 隧道域名变了只改 env，不改代码。
- `src/app/api/health/route.ts`：额外回报 `publicUrl` / `sessionCookie` / `cookieSecure` /
  `nodeEnv`；配置读不出来时给 `configError`，**状态码仍 200**（存活探针不因缺 env 变 500，
  CI 的 smoke 就是 `curl -f /api/health` 且不设任何 env）。
- `contracts/store-api.yaml`：`Health` 加上述可选字段（`required` 未动，向后兼容），
  已 `bun run contract:generate`。
- `src/lib/config.ts`：production + loopback `publicUrl` 时启动打一条 warn。
- `src/lib/auth/http.ts`：`isSameOrigin` **语义不变**，拒绝时 `console.warn` 带 expected/actual
  —— 裸 `origin_mismatch` 分不清"代理改了 Origin"还是"配置没换"。
- `src/lib/use-hydrated.ts`（新）+ 三个页面级表单：提交按钮 `disabled={!hydrated || pending}`，
  保留 `type="submit"`（Enter 提交与可访问性不动）。`AdminAuthShell` 加 `<noscript>` 说明。
- `docs/deployment.md`：新增「反向代理与隧道」小节（症状表 + 6 步 checklist + 两条明确不采纳：
  不用 `X-Forwarded-Host` 推导 publicUrl，不放宽 `isSameOrigin`）；`STORE_DEV_ORIGINS` 进可选表；
  §7 补 `/api/health` 的新字段。
- `service/.env.example`：`STORE_PUBLIC_URL` 的注释写清"换入口就换它"与重启要求。

## 验证

- `bun test src/lib/dev-origins.test.ts src/lib/auth/http.test.ts src/lib/config.test.ts src/app/api/health/route.test.ts`
  → **25 pass / 0 fail**（新增 4 + 6 + 3，config 加 1）。
- `bunx tsc --noEmit` → 干净。
- `bun -e "import('./next.config.ts')"` → 配置可加载；带 `STORE_DEV_ORIGINS` 时列表正确追加。
- `bun run contract:generate` → `api-types.ts` 含 `publicUrl` / `sessionCookie` / `configError`。

## 未验证 / 下一步

- **运行时没验**：4000 上跑的是 03:37 的 `next start`（`BUILD_ID` 早于本轮改动），要看到新
  `/api/health` 字段必须 `bun run build` + 重启。没有在用户实例上擅自 build —— 与运行中的
  `next start` 并发会重写 `.next`。
- **隧道域下 `/_next/static/chunks/*` 是否 100% 加载**未实测：它们与页面同源、`no-cors`，
  按 `blockCrossSiteDEV` 的逻辑不该被拦，但没有真实隧道域名可验。若仍不 hydrate，先看 devtools
  里 `/_next/static/*` 的码，那会把结论从"配置错配"改成"隧道层拦截"，届时改用 `next start`。
- `next start` 下 `STORE_DEV_ORIGINS` 用不上（`allowedDevOrigins` 只作用于 dev）。
- 若论坛 provider 也只在 `127.0.0.1:3000`，外网浏览器打不开授权端点 —— 只 tunnel 商城不够，
  issuer 的 `base_url` 是 DB 行，得在后台「OAuth2 配置」里改。

## 补验（2026-10-25 04:40，隧道域实机）

隧道与配置侧**全部正常**，上面那条"未实测"可以结掉：

- `GET /api/health` → `nodeEnv=development`、`publicUrl=https://test-sforum-app-store.dalao.me`
  （`publicUrlSource=database`）、`cookieSecure=true`。
- HTML 里 17 个 `/_next/static/chunks/*` **全部 200**，体积正常。
- `blockCrossSiteDEV` 的 allowlist 已生效：`Origin: <隧道域>` → 200；`Origin: evil.example` → 403，
  进程日志里有 `Blocked cross-origin request ... from "evil.example"`。
- 写操作也通：`POST /api/admin/session`（隧道 Origin，假凭据）→ 401
  `{"code":"invalid_credentials"}`，**没有** `origin_mismatch`。
- 真实浏览器加载后按钮变可点（`disabled=false`、文案「登录」），说明 hydrate 完成。

**真正的坑：dev 下 SSR HTML 与客户端 chunk 会不同步。** 同一轮里 4 次加载全部报
`Hydration failed`，diff 是 `SidebarNav` 的 className —— 服务端 HTML 是 `py-2.5 text-[14px]`，
客户端 chunk 是 `py-2 text-[13px]`。成因是 dev 的 chunk URL 不含内容哈希，改了源码之后浏览器
仍拿旧 chunk；服务端新、客户端旧，两边渲染不一致。清缓存重载后**零报错**（`Network.setCacheDisabled`
+ 重载，日志里不再出现 hydration 报错）。

结论：`/admin/login` 那颗灰掉的转圈按钮 = `disabled={!hydrated || pending}` 的未 hydrate 态，
不是样式 bug，也不是隧道拦 `/_next/*`。看到它常驻就是客户端 JS 没接管 —— 先硬刷新
（Ctrl/Cmd+Shift+R），再看 devtools 里 `/_next/static/*` 是否 404/403。**别在 dev server
跑着的时候改前端源码再去隧道页验收**，那必然制造 HTML/chunk 错位。

同轮硬化（`components/admin/admin-{login,setup,password}-form.tsx` + `lib/use-hydrated.ts`）：

- 按钮文案按状态分开：未 hydrate 显示「正在加载…」，提交中显示「登录中…/创建中…/更新中…」，
  不再用同一颗转圈冒充两种状态。
- 新增 `useHydrationStalled(hydrated, 8000)`：8 秒还没 hydrate 就在按钮下方给一条明确提示
  （强制刷新 / 查 `/_next/static` 是否被拦），把"像坏了"变成"知道该干什么"。
- login / setup 的 200 响应加 `!result.data` 兜底：代理塞回来的 200 非 JSON 以前会让
  `result.data.mustChangePassword` 抛错，`pending` 永不复位 → 按钮永远转圈。

未验：390×844 的移动端渲染证据没截（浏览器里已有管理员会话，`/admin/login` 直接 307 走了）。
