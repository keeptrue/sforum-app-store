# 仓库绑定与待认领队列

Status: accepted
Date: 2026-10-25

## 背景

商城原本有三处互不衔接的地方，合起来会让「谁拥有这个扩展」由偶然因素决定：

1. `lib/github/sync.ts` 的 `ensureProduct()` 在 release 到达时**自动创建产品**，`owner_account_id`
   取自 installation 的 `account_id`——而那个值只表示「谁在商城里点了安装按钮」，不表示谁拥有
   这个 GitHub 账号或仓库。组织装一次 App、多个成员有权限时，第一个点安装的人拿走全部产品归属。
2. 产品 `repo_id` 为空时 sync 会**自动补写**；`repo_id` 已存在但来源仓库不同时**不做校验**，
   于是任何仓库只要 manifest id 撞上已发布产品，就能给它灌版本。
3. `lib/github/client.ts` 的 `listInstallationRepositories()` 早已实现但**零调用点**；
   dashboard 里没有任何 GitHub 入口，`/api/github/install/start` 除自身登录重定向外无链接指向。
   也就是说开发者看不到自己有哪些仓库，只能在新建产品时手填 manifest id 去猜。

## 决定

### 1. 绑定是显式动作，sync 只做只读判定

`syncRelease` 把 manifest id 解析成四种结果，并且**只写 `bound` 那一种**：

| 判定 | 条件 | 行为 |
| --- | --- | --- |
| `bound` | 产品存在且 `repo_id` 等于来源仓库 | 正常写入版本 |
| `unclaimed` | 没有产品占这个 id | 写一条 `repo_claims`，issue `product_unclaimed` |
| `unbound` | 产品存在但 `repo_id` 为空 | 只记 issue `repo_bind_pending`，不自动补 |
| `mismatch` | 产品绑的是另一个仓库 | 只记 issue `repo_mismatch`，拒绝写版本 |

`unbound` / `mismatch` 不写 claim：产品已经有主，队列里再多一条没人能回答的提案只是噪音。

### 2. 未认领的 id 进队列，认领人必须是安装的持有者

`repo_claims` 以 `(repo_id, extension_id)` 唯一，`pending | claimed | rejected`。
只有「该仓库位于当前账号某个 `active` installation 之下」的记录才会出现在
`/dashboard/claims`。认领**重新读取 release**（`importProductFromRepo`）而不是相信 claim 里存的
清单名与 tag：claim 是线索，release 才是事实。

### 3. 绑定强度分两级，v1 只有弱的那一级

`products.repo_bound_via` = `installation | github_identity`。

- `installation`：仓库位于当前账号名下 `active` installation 覆盖范围。**这不是身份证明**，
  界面写「GitHub App 安装」，不写「已验证」。
- `github_identity`：绑定同时通过已验证 GitHub 身份的权限快照（阶段 2）。

审核台与产品页都读这一列，因此不会出现「看起来已验证、实际只是点过安装」的表述。

### 4. 仓库列表读本地镜像，不在打开页面时打 GitHub

`github_repos` 是唯一来源；「从 GitHub 同步」是显式按钮，走 `repo` 限流通道。
`/installation/repositories` 分页补齐（每页 100，最多 10 页 = 1000 个仓库）；超出预算时
抛 `installation_repo_limit`，**不静默截断**——半个仓库列表比一个明确的错误更糟。

### 5. 已发布产品不可解绑，可换绑

解绑会让下载链接与审核快照失去依据，所以 `published` 状态解绑是 409 `repo_binding_locked`。
换绑允许，且自动进入重新审核——`lib/moderation/policy.ts` 的 `repo_changed` 分支本来就比较
`repoId` 与 `repoIdReviewed`，本轮不需要改策略。

### 6. 导入从 manifest 取身份，不接受手填 id 去碰

`POST /api/dashboard/products/import` 下载最新 release 的 ZIP、读
`sforum.extension.json`，用其中的 `id`/`name`/`type` 建产品，然后**立刻同步同一个 release**：
webhook 在那个产品存在之前就已经跑过，不同步的话产品会一直空着到下一个 release。
ZIP 只落临时目录，`cleanup()` 在 `finally` 里执行。

### 7. 阶段 2：GitHub App user-to-server OAuth，一次性校验、不落库 token

用同一个 App 的 Client ID 走 user authorization，回调时读 `/user` 与
`/user/repos?affiliation=owner,organization_member`，把「这个 GitHub 账号是谁」与「它对哪些仓库
有 admin/maintain 权限」落成快照（`github_identities` + `github_identity_repos`），**token 立即丢弃**。
绑定校验改为「repo_id 出现在该账号某个身份 24 小时内的权限快照里」，`repo_bound_via` 写
`github_identity`。

这样既满足「不存 PAT」，又不把 GitHub 用户令牌变成新的长期凭据面。

## 放弃的方案

- **只做仓库选择器、不动归属**：体验好了，但「谁先发 release 谁拿产品」的洞还在。
- **认领靠 N 天自动转移**：会奖励抢注，且归属变更无法回溯到人。
- **仓库 claim 文件（根目录写 `sforum.claim`）**：证明力强、零新凭据，但要求开发者多一次手工
  push；阶段 2 若 OAuth 走不通可作为回退。
- **存 user token 以便随时刷新仓库列表**：多一份要加密轮换的长期凭据，收益只是少一次授权点击。

## 代价与重开条件

- 阶段 1 的绑定强度弱：共享 installation 下，任何有该 installation 的账号都能绑该仓库。
  审核台显示的是 `installation`，不是「已验证」。阶段 2 落地后新绑定自动升级。
- 阶段 1 的「谁点安装谁拥有 installation」没有变，只是**产品归属不再由 release 决定**。
- 若 GitHub 收紧 `/installation/repositories` 的分页或速率，`syncInstallationRepos` 的页预算要重估。
- 若将来允许一个论坛账号绑定多个 GitHub 身份并合并产品，`repo_claims` 的认领证据要跟着改。

## 落地

- 迁移 `0008_careful_lily_hollister.sql`：`repo_bound_via` / `repo_claim_state` 两个枚举、
  `products.repo_bound_at` / `repo_bound_via`、`repo_claims` 表。
- `lib/github/repos.ts`（仓库镜像与可绑定判定）、`lib/github/claims.ts`（队列）、
  `lib/products/binding.ts`（绑定/解绑/导入）。
- 7 个 dashboard 端点，全部走 `authorizeDashboardRequest`；写操作另加 `repo` 限流。
- UI：`RepoPickerDialog`、`RepoBindingPanel`、`ImportProductDialog`、`/dashboard/claims`。
- 测试：`repos.test.ts`、`claims.test.ts`、`binding.test.ts`、`binding-routes.test.ts`，
  以及 `sync.test.ts` 重写为「claim 而非建产品」。
