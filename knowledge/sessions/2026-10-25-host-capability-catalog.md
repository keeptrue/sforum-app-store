# 宿主能力目录对齐（标签 · 等级 · 聚合）

Date: 2026-10-25
Plan: `plans/2026-10-25-host-capability-catalog.md`（active，待人工验收）
Decision: `decisions/2026-10-25-host-capability-catalog.md`

## 这一轮解决什么

商品页的「声明的能力」只有裸 key 加一句「安装时由论坛展示」，而宿主早在
`apps/api/app/Support/Capabilities/catalog.go` 里给每条能力定了中文标签、risk 等级和描述，
并导出成 `docs/extensions/catalogs/capabilities.md`（宿主 CI 用 `extension docs generate --check`
守漂移）。`oauth2-provider` 的四项能力在宿主眼里是 2 低 2 高，在商城里完全等价——这是本轮
要补的信息缺口。

## 做了什么

- vendored 宿主目录：`service/src/lib/capabilities/catalog.json`（13 条）+ `catalog.lock.json`
  （commit `8662d07` / sha256 / bytes / entries / docDirty / syncedAt），来源是宿主的**生成物**
  markdown 表，不是 Go 源码正则。
- `service/scripts/sync-capability-catalog.ts`：`--sforum` 生成、`--check` 校验（纯本地）；
  根与 service 各加 `capabilities:sync` / `capabilities:check`；CI 加 `Capability catalog drift`。
- `service/src/lib/capabilities/catalog.ts`：`capabilityEntry` / `describeCapabilities`
  （高→中→低→未知垫底，与宿主启用审查同序）/ `summarizeCapabilities` / `capabilityBreakdown`。
- 商品页：每行 = key + 宿主中文标签 + 等级徽标 + 折叠的「宿主说明（英文原文）」；顶部聚合
  （`4 项能力 · 高 2 · 中 0 · 低 2 · 最高等级`）；侧栏安装包卡加 chip（跟随**选中**版本）；
  来源行带 commit 短码；两条限定文案（等级 ≠ 插件质量、宿主会推断追加）。
- 审核台 `capability-diff`：每键两行（key + 标记 / 等级徽标 + 中文标签），两列同序，
  底部补「未审 N 项，其中 M 项高风险」，闸门文案明确「等级只排优先级」。
- 契约与数据零变化：`releases[].capabilities` 仍原样透出，无 API/DB 变更；`contract:generate`
  复核无 diff。

## 验证

- `bun run capabilities:check` → 13 entries, lock matches, upstream `8662d07`
- `bun test --parallel=1` → 708 pass / 0 fail（新增 10 条目录用例 + 4 条审核台 SSR 渲染用例）
- `bun run typecheck` → 干净
- 商品页 SSR 已含「调用宿主 API / 读取用户信息 / 读取本人邮箱地址 / 低风险 / 高风险 / 最高等级 /
  含 2 项高风险能力」；截图 `tmp/capabilities-tab-1633.png`、`tmp/capabilities-tab-390.png`
  （390 下 `scrollWidth === 390`，无横向溢出）

## 未做 / 待确认

1. **审核台真机截图缺**：本地 `/admin` 302 到登录页（`root` 账号存在但无会话），改用
   `capability-diff.test.ts` 的 `renderToStaticMarkup` 断言。有会话时补 1633/390 两张。
2. **`capabilities:verify-upstream` 未实现**（按 lock 的 commit 从 GitHub 复核漂移）：计划 PQ2
   建议放月度例检，不进 CI 必跑。当前漂移发现靠人工 sync。
3. **宿主 `capabilities.md` 5 列结构不是长期承诺**：解析器按列数硬校验，宿主加列时这里会红。
4. **插件管理页（论坛内）仍显示裸 key**：它只消费公开 API，要同等信息得先加目录端点（本轮
   明确不做）。
5. 生产构建本轮未跑（dev server 占着 `.next`）；JSON import 是标准能力，CI 的
   `bun --bun next build` 是权威证据。
6. 观察到一次**与本次改动无关**的偶发失败：`catalog visibility > totals, ordering and shape of
   a summary row` 在全量跑中出现 1 次，单跑与随后全量均通过（疑与 `updated_at` 并列排序有关，
   未深查）。
