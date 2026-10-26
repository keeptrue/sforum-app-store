# 2026-10-26 兼容过滤：dev 默认不过滤 + 预发布基线对齐

## Changed

- **服务端默认口径**（`service/src/lib/catalog/query.ts`）：`parseCatalogQuery` 先解析
  `sforum` / `sforumBuild`，再定
  `compat = compatParam ?? (isDevBuild(sforumBuild) ? "all" : "compatible")`。dev 宿主的
  coreVersion 只是派生近似值，按它过滤会把能装的包藏起来。显式 `compat` 仍然最优先。
- **口径回显**：`listCatalog` 回填 `CatalogPage.compat`（`compatible | all`，**可选**字段）。
  省略参数的调用方否则分不清「dev 默认 all」和「显式要 compatible」。
- **契约**（`contracts/store-api.yaml`）：`CatalogPage.compat` 可选；`/v1/catalog` 的
  `compat` 参数描述改成「省略时按宿主构建决定」；`Compatibility.estimated` 改成 git tag
  口径（dev 版本号来自最近的 tag，判定仅供参考，最终以安装时 core 为准）。
  `service/src/lib/api-types.ts` 由 `contract:generate` 重生成，无漂移。
- **预发布求值**（`service/src/lib/semver-constraint.ts`）：`ConstraintGroup` 新增
  `mentionsPrerelease`；求值 = 组级 `includePrerelease`（对应 Masterminds 的 `containsPre`）
  → 仍不满足且版本带预发布时用 `major.minor.patch` 基线重试一次（对应
  `CheckSForumVersion` 的 `releaseBase`）。`!=` 排除项两次求值都生效。
- **插件侧**（小前）：`catalogCompat` 空值不再兜 `compatible`（留空交给商城决定），
  `mapping.go` 透传 `compat`，管理页新增 `auto` 模式跟回显走；显式 `compatible` 现在真的
  发送 `?compat=compatible`。整条链路已通。
- **测试串味**（预存在问题，本轮修掉）：`service/src/lib/download/{issue,resolve}.test.ts`
  在 `beforeAll` 写 `STORE_PUBLIC_URL=http://127.0.0.1:3999` 且不还原，同进程后面的
  `github/app-config.test.ts`（期望 `:3000`）因此稳定失败。改为 `applyTestEnv()` /
  `restoreTestEnv()`（原本未设置的键删除），并在 teardown 调 `resetRuntimeConfigForTests()`
  —— 只还原 env 不够，运行时设置缓存有 15 s TTL，会把 `:3999` 继续喂给下一个套件。

## Evidence

- **与 core 的判定矩阵**：用 Go 直接跑 Masterminds **v3.5.0**（`apps/api/go.mod` 钉的版本）
  生成 **420 行**（22 条约束 × 15 个版本，含 `3.0.13-alpha.2` / `3.0.13-alpha.6` /
  `3.0.16+13.gabc` / `3.0.12-beta.1` / `1.1.0-beta.1` / `4.0.0-alpha.1` 等），与 service
  实现逐行对比 **0 mismatch**。
- **只做 baseline 重试会漏 4 行**（全部是「core 收、store 藏」，即本次要根治的方向）：
  `>=3.0.12-alpha.7 <3.0.13` × `3.0.13-alpha.2`、同 × `3.0.13-alpha.6`、
  `>=3.0.12-alpha.7 !=3.0.13` × 这两个版本。原因是 core 在组内出现任一预发布比较符时
  整组按预发布比较，而 node-semver 只认「同一 tuple 的预发布比较符」。所以补了组级
  `includePrerelease`，baseline 重试保留。
- **第 4 条断言的定夺**：`3.0.13-alpha.2` + `>=3.0.13-alpha.5` → **true**。core 首次
  Check 为 false（alpha.2 < alpha.5），`releaseBase` 的 `3.0.13` 满足该约束，函数返回 nil；
  Go 实测 `first=false / withBase=true`。这是基线重试的结果，不是预发布区间被放宽。
- **一条旧用例被改**：`compat.test.ts` 原断言 `1.1.0-beta.1` 不满足 `>=1.0.0`，与 core
  相反（同样 `first=false / withBase=true`）。改名并保留 `!>=1.2.0` 的边界；不改会把假阴性
  固化成规格。
- **闸门**（2026-10-26 实跑）：
  - `cd service && bun test` → **770 pass / 0 fail / 2616 expect / 65 files**；
    `bun run test`（`--parallel=1`）同结果。
  - `bun run typecheck` → exit 0。
  - `bun run manifest:check` → `manifest schema OK: d6950113…`（摘要未变）。
- **目录行为**（`query.test.ts`）：dev 宿主（`sforumBuild=dev-*`）不传 `compat` → 返回全部
  且 `compat=all`；非 dev 不传 → 默认 `compatible` 并剔除；dev 上显式 `compatible` 仍过滤；
  空页响应也带 `compat`。
- **真实 dev 版本串**（`query.test.ts`，补于审查后）：新增两个夹具 —— `oauth2-provider`
  （约束 `>=3.0.12-alpha.7`，就是这轮要救的那个包）与 `future`（约束 `>=4.0.0`，给「显式
  compatible 要真的剔除」提供对象）。三条用例都用宿主真实形状 `3.0.16+13.g6f94488ad`：
  默认 `compat=all` 返回全部 7 项；显式 `compatible` 保留 oauth2-provider 并剔除 `future`
  与 `markdown`；非 dev 带 build metadata 默认 `compatible` 且 `estimated=false`。此前三条
  dev 用例都驱动 `sforum=1.5.0`，没覆盖这个字符串形状。分页用例同时改成「按 cursor 翻到空」
  （不再硬编码三页），夹具增减不会再把它弄红。

## Known limits

- **前台与插件页不对称（已裁决：保持）**：插件管理页已改成 status 优先、dev 说明只留页级；
  service 公开站（`components/storefront/catalog-format.ts`）仍按 `estimated` 出逐卡「按开发版
  估算」徽标，同时页级也有说明。公开站的 `sforum` / `sforumBuild` 是**访客手写 URL 声明的**，
  不是宿主握手事实，所以按声明显示「按开发版估算」是诚实的，不跟插件页统一。
- **老宿主仍走 1.0.0 兜底**：`sforum` 缺失/非法（没有 host_build 的旧宿主）时
  `effectiveHostVersion` 回落 `1.0.0` + `estimated=true`，且默认 `compat=compatible` ——
  老宿主 + dev 构建仍会按 1.0.0 过滤。这是 Q6 已裁决行为，本轮未动。
- **node-semver 与 Masterminds 的理论差异**：矩阵覆盖范围内 0 mismatch，但极端 dirty range
  （如 `1.2.3 - 3.0.12`、`3.0.x`）两库的边界语义并未穷举。
- **其它测试文件仍各自设置 `STORE_PUBLIC_URL` 不还原**（除 `app/api/health` 自己管理之外，
  还有 17 个），只是值都是 `:3000`，今天无害；`download/` 两个文件是本轮唯一造成串味的。
  若再出现第三个，考虑把 `applyTestEnv/restoreTestEnv` 抽到 `lib/test-support`。

## Next

- 若要让调用方看到「这次到底过滤没有」以外的东西（例如按 `compat` 显示不同提示），现在
  `CatalogPage.compat` 已经够用，前端可直接消费。
- 老宿主（无 `sforum`）的 1.0.0 兜底要不要也放宽成 `all`，需要产品口径决定，不是实现问题。

## Open Questions

- 契约里 `CatalogPage.compat` 保持可选到什么时候：等旧插件都升级后再设 required，还是永久可选。
