# GitHub 仓库绑定：选择器 + 待认领队列（阶段 1）

Date: 2026-10-25
Decision: `decisions/2026-10-25-github-repo-binding.md`

## 一句话

开发者现在能在商城里看到自己 GitHub App 覆盖的仓库、从仓库导入产品、绑定/换绑/解绑；
release 不再凭「谁先发」自动变成谁的产品，未认领的扩展 ID 进 `repo_claims` 队列等归属。
阶段 2（GitHub 身份 OAuth）尚未开始。

## 本轮修掉的三件事

1. `syncRelease` 的 `ensureProduct()` 会在 release 到达时**自动建产品**并把归属给「点了安装按钮的人」。
   现在它只做只读判定：`bound` 才写版本，`unclaimed` 写 claim，`unbound` / `mismatch` 只记 issue。
2. `repo_id` 为空时自动补写、来源仓库不同也不校验 → 任何仓库只要 manifest id 撞上已发布产品
   就能灌版本。现在 `repo_mismatch` 直接拒绝。
3. `listInstallationRepositories()` 零调用点、dashboard 无 GitHub 入口、`/api/github/install/start`
   无链接指向——整条链路在 UI 上不可达。现在有仓库选择器、连接入口与导入对话框。

## 落地清单

- 迁移 `0008_careful_lily_hollister.sql`：`repo_bound_via` / `repo_claim_state` 枚举、
  `products.repo_bound_at` / `repo_bound_via`、`repo_claims`（`(repo_id, extension_id)` 唯一）。
- 新模块：`lib/github/repos.ts`（分页镜像、可选仓库、`findBindableRepo`）、
  `lib/github/claims.ts`（队列）、`lib/products/binding.ts`（绑定/解绑/导入）。
  `upsertRepo` 从 `jobs.ts` 移到 `repos.ts`，webhook 与选择器共用一份写入。
- `createProduct` 去掉从未使用的 `_assetStore` 参数（3 处调用点同步）。
- 7 个端点：`/api/dashboard/github/{installations,repos,repos/refresh}`、
  `/api/dashboard/products/import`、`/api/dashboard/products/[id]/repo`（POST/DELETE）、
  `/api/dashboard/repo-claims`、`/api/dashboard/repo-claims/[id]/claim`。
- UI：`RepoPickerDialog`、`RepoBindingPanel`（产品页右列，审核之上）、`ImportProductDialog`
  （门户页头）、`/dashboard/claims`、门户页「N 条 release 等待认领」提示条。
- 测试基座：`lib/test-support/db.ts` 的 `TRUNCATE_ALL` / `TRUNCATE_TABLES` 替换了 19 处手写
  TRUNCATE 列表（`repo_claims` 只需加一次），download 两处 `LOCK TABLE` 复用同一份表名。

## 验证

- 全量 `bun test`：**430 pass / 42 files / 0 fail**（新增 `repos.test.ts` 15、
  `claims.test.ts` 8、`binding.test.ts` 19、`binding-routes.test.ts` 11；`sync.test.ts` 重写）。
- `bun --bun next build` 通过，新路由全部出现在路由表。
- `tsc --noEmit` 干净。
- 渲染证据（`bun --bun next start -p 4100` + 临时会话 cookie，演示数据已清理）：
  `tmp/binding-dashboard-1633.png`、`tmp/binding-product-1633.png`、
  `tmp/binding-picker-1633.png`、`tmp/binding-claims-1633.png`、
  `tmp/binding-product-390.png`（`scrollWidth == 390`，无横向溢出）、
  `tmp/binding-panel-390.png`。

## 踩到的坑（下次别重犯）

- **4000 端口那个 `next dev` 的客户端 chunk 是旧的**：SSR 输出新 UI，但页面完全没有 hydration，
  点按钮毫无反应。同一个页面在 4100 的 `next start` 上一切正常。判断方法是点主题切换看
  `documentElement.className` 是否变化——不变就是没 hydrate，别去怀疑自己的 onClick。
- `ego_cdp` 的 `Emulation.setDeviceMetricsOverride` **跨调用不保留**（每次都是新连接），
  必须在同一个 `ego_script` 里设置 → 截图。截图要桌面宽度时用
  `Page.captureScreenshot` + `captureBeyondViewport: true` + `clip`，`ego_screenshot` 只截窗口。
- `pkill -f "next start -p 4100"` 会匹配到执行它的那条 shell 命令行，把自己 SIGTERM 掉。

## 未验证

- **真实 GitHub App 上的 `getLatestRelease` 与 `downloadAsset` 组合**：单测用的是注入的
  `ImportClient` 假实现，真实 App 的 404 语义（仓库没有 release）与 90s 超时未在线上验过。
- **`/installation/repositories` 的真实分页行为**：10 页 / 1000 仓库的上限是按文档设的，
  没有在仓库数超过 100 的安装上跑过。
- **阶段 2 的 OAuth 前提**：GitHub App 是否已生成 client secret、`/user/repos` 是否返回
  `permissions.admin`，都未验证；`decisions/2026-10-25-github-repo-binding.md` 里写了回退方案。
- 浏览器点击「从仓库导入」的完整成功路径（需要真实 App + 真实 release）。

## 已知缺口

- `docs/developer.md` 原本写着「产品页手动刷新」可以重同步 release——**代码里从来没有这个入口**
  （选择器的「从 GitHub 同步」只刷仓库列表）。本轮把文档改成实话；真正的「重同步某个 release」
  还没做，webhook 漏投只能靠运维重投。

## 下一步（阶段 2）

1. `config.ts` 加 `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET`。
2. 迁移 `0009`：`github_identities`、`github_identity_repos`。
3. `/api/github/oauth/{start,callback}`：换 token → `/user` + `/user/repos` 记权限快照 →
   **token 立即丢弃**。
4. `requireBindableRepo` 增加「repo_id 在某个身份 24h 快照里且 permission ∈ admin|maintain」，
   命中时 `repo_bound_via` 写 `github_identity`。
5. 审核台与产品页按 `repo_bound_via` 措辞（已有 `REPO_BOUND_VIA_LABELS`）。
