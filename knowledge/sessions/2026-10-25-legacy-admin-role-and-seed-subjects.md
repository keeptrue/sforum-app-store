# 2026-10-25 遗留 admin 行不再放行 + 演示数据与真实身份解耦

## 结果

首次 OAuth2 授权登录后，账号 `大佬 · official#1` 直接看到 4 个「我的产品」和一个能进的审核台。
两个独立原因，一起修掉了：

1. **账号键撞车**：本地论坛用户 `zhuchunshu` 的 `sub` 是 `1`，而 `seed:dev` 把演示账号写成
   `(issuer_key='official', sub='1')`。登录走 `upsertAccount` 的
   `onConflictDoUpdate(target: (issuer_key, sub))`，于是「第一次登录」命中的是种子行，直接继承
   了它的产品归属（`products.owner_account_id`）。
2. **遗留 admin 行仍在放行**：`store_roles` 里有一行 `(232c608d…, admin, granted_by='bootstrap',
   2026-10-24T00:16:32Z)`，来自 S1 的「首个登录者即管理员」。决策
   `2026-10-25-admin-local-identity.md` 写的是「旧行保留但不参与鉴权」，但代码没兑现：
   `getRoles` 原样返回所有行，`app/moderation/page.tsx` 与 `lib/moderation/service.ts` 的集合都是
   `["admin","moderator"]`，所以旧行实际给了审核台。

验证：`bun test --parallel=1` → **375 pass / 0 fail / 38 files**（+1 例：遗留 admin 行不产生会话
角色；`routes.test.ts` 的队列用例改成「admin 行 403」）；`bunx tsc --noEmit` 干净；真机
`127.0.0.1:4000` 上用真实账号会话验证 `/dashboard` 为 0/0/0 空态、`/moderation` 返回 404
（RSC 里 `NEXT_HTTP_ERROR_FALLBACK;404`）。截图 `tmp/verify-dashboard-empty-1633.png`、
`tmp/verify-moderation-404-1633.png`（注：ego 截图取的是窗口表面 500×864，布局宽度证据来自
`innerWidth=1633` + `matchMedia('(min-width:1024px)')=true`）。

## 关键实现事实

- **`ActiveStoreRole = "moderator"`**：`CurrentSession.roles` 的类型收窄成只有 `moderator`，
  于是任何面想再 `roles.includes("admin")` 都是编译错误，而不是运行期静默放行。
- **`getRoles` 双保险**：SQL 侧 `and(eq(accountId), eq(role,'moderator'))`，TS 侧再
  `.filter((role): role is ActiveStoreRole => role === "moderator")`。drizzle 的枚举列即使
  `where` 已经收窄，返回类型仍是 `"admin" | "moderator"`，只靠 SQL 过滤过不了 `tsc`。
- **两个 MODERATOR_ROLES 都只留 `moderator`**：页面 404 门与 API 403 门各一处，不能只改一处。
- **`seed:dev` 的 sub 改成 `dev-1` / `dev-2`**：真实论坛 subject 是数字，非数字 subject 让演示
  数据从真实账号永远不可达。`github_installations.account_id` 同步跟着 `accountIds.get("dev-1")`。
- **没有重跑 `seed:dev`**：它会把所有产品 `status` 重置成 `published`，会抹掉手工做出来的
  `s4-2` 待审核/驳回演示。改用等价的一次性 SQL（建 dev 账号 → 搬 `owner_account_id` → 删遗留
  admin 行），保留 `pending_review` 状态。

## 现场处置（已执行，dev 库 `sforum_store`）

- `delete from store_roles where role = 'admin'`（1 行）。
- 新建 `(official, dev-1)`、`(official, dev-2)`；4 个产品从 `sub=1` 搬到 `dev-1`，`theme-quiet`
  从 `sub=2` 搬到 `dev-2`。
- 结果：真实账号 `(official,1)` 名下 0 产品、0 角色；`/moderation` 对其 404，`/dashboard` 空态。

## 侧栏入口（同轮追加）

「审核台」原本是 `console-nav.tsx` 里无条件渲染的静态项，于是没有角色的账号看得见入口、点进去
404 —— 一个产品不该许下的承诺。现在角色从布局传进导航：

- `components/dashboard/session.ts` 新增 `readConsoleSession()`（可为空，只服务 chrome）与
  `canModerate(session)`；`requireDashboardSession()` 仍是页面级门，两者职责分开。
- `app/dashboard/layout.tsx` 与 `app/moderation/layout.tsx` 变成 async，读会话后把
  `canModerate` 传给 `ConsoleShell` → `ConsoleNav`，链接表用 `moderatorOnly` 标记过滤。
- 实测：真实账号（无角色）导航只有「目录 / 开发者门户」，临时 moderator fixture 上三个都在；
  证据 `tmp/nav-nonmoderator-1633.png`（moderator 那张被人工接管窗口打断，只留 DOM 证据）。

**ego 环境的一个坑**：dev 的 `STORE_PUBLIC_URL=http://127.0.0.1:4000` → `cookieSecure=false`
→ 会话 cookie 名是 `store_session`，不是 `__Host-store_session`。之前用 `__Host-` 前缀设的
cookie 一直没被读，验证其实是靠浏览器里已有的真实会话过的；换身份验证必须设 `store_session`。

## 未验证 / 遗留

- 未做「审核员仍能进」的真机点击验证（用 `routes.test.ts` 的 moderator 200 覆盖）。
- 404 渲染时审核台外壳是否整体被替换：本次实测被整体替换（DOM 里无 `aside`），但这是
  `not-found.tsx` 在根段的结果，别当成「外壳会主动隐藏导航」。
- 移动端 Sheet 里的同一份链接：DOM 上已确认跟随过滤，未做窄屏截图。
