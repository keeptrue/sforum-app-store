# 2026-10-26 架构可用性（latestPlatforms / platform 维度）Handoff

## Changed

**服务端（`service/`）**
- `contracts/store-api.yaml`：`ProductSummary.latestPlatforms`（必填，`array<Platform>`）；
  目录查询新增 `platform`，`enum [strict, all]`、默认 `strict`。
- `src/lib/catalog/query.ts`：`CatalogQuery/CatalogView` 加 `platform`；
  `buildSummary` 用 `latestRow` 算 `latestPlatforms`；strict 过滤只在
  `platform !== 'all'` 时生效；`platform=all` 时 `compat` 改用
  `compatibilityOf(..., null, null)` 只判版本轴；`queryFingerprint` 加入 `platform`。
- `src/lib/api-types.ts` 重新生成。

**插件后端（`plugin/plugins/sforum.store/backend`）**
- `handlers.go` 解析 `platform`（`all`/`strict`，非法 400）；`upstream.go`
  `catalogQuery.PlatformAll` → 只在放宽时发 `platform=all`；`mapping.go` 输出
  `latestPlatforms`，上游缺字段回落 `platforms`。
- `schemas/catalog.response.json`、`schemas/product.response.json` 同步
  （`additionalProperties:false`）。

**管理页（`plugin/.../frontend/admin/src`）**
- 新建 `platform.ts`（`supportsTarget` / `releaseSupportsTarget` / `preferredRelease`）
  与 `foot.ts`（版本/平台/状态位/主按钮的节点构造）。
- `logic.ts`：`defaultPlatform` 在 `target` 已知时去掉 `platforms[0]` 静默回退；
  `installGate` 新增 `platformUnsupported`（**平台判定先于版本判定**）；
  `to*View` 输出 `supported`。
- `catalog.ts`：`platformOnly`（默认开）+ `target` 状态、工具条「只看支持当前架构」
  开关、详情默认 `preferredRelease`、最新版不支持时通知槽说明。
- `view.ts` 卡片徽标；`copy.ts` zh/en 8 个新 key。

## Evidence（实测）

- `cd service && bun run typecheck` 绿；`bun run test` **790 pass / 0 fail**（66 files）；
  `bun run contract:generate` 后 `api-types.ts` **NO_DIFF**。
- 插件后端 `go vet` + `go test -count=1` 绿；插件前端 `bun test .../admin/src`
  **162 pass / 0 fail**（895 expect）。
- `bash plugin/scripts/build.sh` 绿：digests 3 updated、manifest OK；`backend/plugin`、
  `catalog.mjs`、`catalog.css` 三份 sha256 与 `sforum.extension.json` 逐项一致；
  `dist/catalog.mjs` 能 grep 到「只看支持当前架构」。
- 真机（宿主 1633×810 / 390×844，均无横向溢出）：
  - strict=4 条、all=5 条（仅 all 出现「所有版本都跑不了」的产品）；`platform=bogus` → 400。
  - 卡片徽标：最新版异架构 →「最新版不支持当前架构」；全不支持 →「不支持当前架构」；
    支持的不加徽标。
  - 弹窗默认选**最新可运行版本**（1.0.0）并说明「最新版 v2.0.0 没有为 linux/amd64
    构建的安装包，已为你选中 v1.0.0」；手动选 2.0.0 → 按钮 `install-blocked` + disabled
    + 原因文案；平台下拉只剩 `linux/amd64`（无 any 时）。
  - 键盘 Tab 到「只看支持当前架构」有可见焦点环（UA `outline auto 1px`）。
  - 两个开关文案/位置可区分，未与既有「只看当前版本可安装」撞车。

## DB 事故与恢复（同批发生，已恢复）

**根因**：`service/` 下 Bun 自动加载 `.env.local`，`DATABASE_URL` 指向 dev 库
`sforum_store`；一个一次性 dump 脚本开头 `delete` 产品表，首轮插入失败但删除已生效。
**不是测试套件**（测试走 `TEST_DATABASE_URL ?? sforum_store_test`，且
`TRUNCATE_ALL` 会连 accounts/assets/settings 一起清，而这些仍在）。

**恢复**：`0/0/0/0`（products/versions/release_assets/repo_releases）→ 删脏行
`github_repos where repo_id=777001`（1→0）→ `bun run seed:dev` → `3/7/9/7` →
验收夹具（`qa-platform-fixture`、`qa-platform-maconly`）插入并删除 → 复查仍
`3/7/9/7`，`slug like 'qa-platform-%'` = 0。全程只碰 `sforum_store`，
`sforum_store_lead` / `_test` / `_test_a` / `_test_b` 未动。

**规则**：一次性脚本必须显式赋值目标库，不要用 `??=` 那种「没设才用默认」的写法。

## Residual / 未验证

1. 旧服务端（无 `latestPlatforms`）回落：只做了响应注入验证（拦截宿主转发、删字段后
   页面不误判、不加徽标、不锁安装）+ 单测；没有真的旧服务端可指，夹具那条组合未真机。
2. 运行阶段 409 只有宿主 Go 单测（见 SForum handoff）。
3. 观测（未定性）：插件路由 `/api/v1/extensions/sforum.store/api/store/catalog` 返回
   `total=3`，而同参数直接请求 `127.0.0.1:4000` 与隧道都返回 4（含当时夹具）；
   隧道 `cf-cache-status: DYNAMIC`，等 45s 仍未变。排查「插件路由少一条产品」时从这里入手。
4. 宿主侧平台文案在用户 dev server 上显示 raw i18n key（i18n 产物早于 locale 编辑），
   属宿主环境，记录在 SForum handoff。

## Next

1. 若要让「旧服务端回落」有真机证据：起一份不带该字段的旧版服务，或临时把
   `catalog_base_url` 指向一个返回旧结构的桩。
2. 需要时补「平台下拉含 `any/any`」的真机样本（当前夹具里没有 any 版本）。
