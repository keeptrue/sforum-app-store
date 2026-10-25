# 宿主能力目录对齐（标签 · 风险等级 · 聚合）

Status: **active（2026-10-25 落地，待人工验收）**
Started: 2026-10-25

- **前置**：`plans/2026-10-24-app-store-service.md`（S0–S6 交付）、
  `decisions/2026-10-24-s4-review-flow.md` §4——「能力不区分风险等级（v1）」的理由是
  「权限/能力目录尚未定稿」，代价是低风险键也触发复审，并写明**目录定稿后重开本条**。
  本计划就是那次重开的执行版（只重开「展示」，不重开「闸门」）。
- **本轮性质**：展示层的语义对齐 + 一个 vendored 契约。不动身份线、不动发布策略。
- **决策记录**：落地后写 `decisions/2026-10-25-host-capability-catalog.md`，并在
  `decisions/2026-10-24-s4-review-flow.md` §4 补一条指向。

## 0. 结论先行

**能跟随，但只能跟随「谁给出的」，不能跟随「当前这台论坛的判断」。** 三个硬约束决定了形态：

1. **公开商品页没有宿主上下文。** 商品页在商城域名下渲染（`/p/[slug]`，`force-dynamic`），
   浏览者可能根本还没登录任何论坛。所以目录只能是**构建期 vendored 快照**，不是运行时问宿主。
2. **商城看到的是「声明」，宿主看到的是「解析后」。** 宿主会按 backend / settings / jobs /
   `mail.provider` **推断追加**能力（`Capabilities/resolve.go`）。商品页只列显式声明，
   所以必须写明「最终授权以论坛启用页为准」，否则会把不完整集合说成完整集合。
3. **宿主的 risk 是「授权面等级」，不是「插件可信度」。** `capabilities.md` 开宗明义：
   capability 约束的是插件进程能调用的宿主面，与用户 RBAC 无关。文案必须带上这个限定。

因此本轮的口径是：**标签与等级逐字取宿主目录，商城只做展示与排序，不新增任何自己的分级，
也不把等级用于自动发布判定。**

## 1. 目标与非目标

**目标**

1. 商品页能力列表从「裸 key + 一句通用说明」变成「宿主中文标签 + 等级徽标 + 可展开的宿主原文」，
   按宿主顺序（高 → 中 → 低）排列。
2. 未展开列表也能看到风险概况：能力面板顶部聚合一行，侧栏「安装包」卡加一枚 chip。
3. 审核台的能力差异（`capability-diff`）同样显示标签与等级，审核员不必背 key。
4. 目录 vendored 到 `service/src/lib/capabilities/`，带 commit + sha256 lock，脚本
   `capabilities:sync` / `capabilities:check`，CI 守**本仓内部**一致性。
5. 未知键与「宿主会推断追加」都有明确中文文案；未知键灰显，不猜等级。

**非目标（本轮明确不做）**

- **不改公开 API**：`releases[].capabilities` 仍是原始 key 数组；不新增 `/api/v1/capabilities`。
  展示层在渲染时补标签，契约面保持「原样透出」的诚实性。
- **不改自动发布闸门**：保留「任何未审过的能力键都重新进审」。风险分级一旦进闸门就是政策变更，
  需要独立决策记录与新测试（见 §9 PQ3）。
- **不做运行时向宿主取目录**：需要宿主新增 bridge/host 面（当前 `hostActions` 只有
  `extension.install`），是跨仓改动 + 宿主发版节奏问题。
- **不复制宿主推断逻辑**（不自己算「会追加哪些键」）。
- **不改插件管理页**（`plugin/plugins/sforum.store/frontend/admin/`）：它走公开 API，若要同等
  信息就先得有 API 端点，本轮已排除。

## 2. 已核实的宿主事实（证据）

| 事实 | 位置 |
| --- | --- |
| 目录是 `Definition{Key, Risk, LabelZH, LabelEN, Description}`，risk ∈ `low\|medium\|high`，共 13 条 | SForum `apps/api/app/Support/Capabilities/catalog.go` |
| `GrantsFromKeys` 已按「高风险优先」稳定排序，供启用审查 UI 用 | 同上 |
| 清单里目录外的 key 直接判错（`ErrUnknown`），所以宿主侧不存在「未知键被放过」 | `ValidateKeys` 同上 |
| 宿主把目录导出成 5 列 markdown 表 `docs/extensions/catalogs/capabilities.md`，由 `go run ./cmd/sforum extension docs generate` 生成，CI `/extension docs generate --check` 守漂移 | SForum `apps/api/sdk/plugin/docsgen.go`、`cmd/sforum/docs.go` |
| 宿主中文口径就是「低风险 / 中风险 / 高风险」 | SForum `apps/web/i18n/locales/zh-CN.json` → `admin.extensions.capabilityRisk` |
| 推断规则：backend → `host.api`；settings → `settings.own`；jobs → `jobs.enqueue`；`mail.provider` → `net.outbound` | SForum `apps/api/app/Support/Capabilities/resolve.go` |
| 商城现状：能力 tab 只列 key + 「安装时由论坛展示，管理员可以逐项拒绝」 | `service/src/components/storefront/product-view.tsx:481-518` |
| 清单解析已去重 + 字母排序 | `service/src/lib/detection/manifest.ts:407` |
| 契约注释明写「原样透出，不带风险等级判定」 | `contracts/store-api.yaml:508-512` |
| v1 不区分等级的既有决策与重开条件 | `knowledge/decisions/2026-10-24-s4-review-flow.md` §4 |

## 3. 本轮已选组合（人工裁决 2026-10-25）

| 决策点 | 选择 | 被否选项与代价 |
| --- | --- | --- |
| D1 数据源 | **内置宿主快照**（pinned commit + sha256 lock + sync/check） | ①运行时只问宿主：公开前台没有宿主上下文，这屏永远空；②快照 + 论坛内实时覆盖：需宿主新增面，跨仓两期；③只深链宿主文档：用户跳出商城、版本对不上 |
| D2 呈现强度 | **标签 + 等级徽标 + 聚合，闸门不动** | ①只翻标签不出现「风险」：信息最少但用户在决定安装前拿不到等级；②徽标 + 接进闸门：政策变更，需独立决策与测试；③维持现状：等于不回答这个问题 |
| D3 落地面 | **公开商品页 + 审核台能力差异** | 插件管理页需先有 API 端点；公开 API 端点本轮不需要 |
| D4 未知键 / 推断 | **灰显未知键 + 推断声明** | ①只灰显：会让人以为声明集合 = 最终授权集合；②未知键按高风险：把宿主新增的低风险键显示成危险项；③复算推断：复制宿主逻辑并要长期对拍 |

## 4. 设计

### 4.1 数据文件

`service/src/lib/capabilities/catalog.json`

```json
{
  "entries": [
    { "key": "ai.invoke", "risk": "medium", "labelZh": "调用宿主 AI 网关", "labelEn": "Invoke Host AI gateway", "description": "…" }
  ]
}
```

字段逐字来自宿主 `capabilities.md`，不改写、不翻译、不省略 `description`；`entries` 按 `key`
升序（渲染时按等级重排，存储顺序保持可 diff）。

`service/src/lib/capabilities/catalog.lock.json`

```json
{
  "upstream": "github.com/zhuchunshu/sforum",
  "source": "docs/extensions/catalogs/capabilities.md",
  "commit": "<生成该文档时的宿主 HEAD>",
  "sha256": "<catalog.json 字节的 sha256>",
  "bytes": 4321,
  "entries": 13,
  "syncedAt": "2026-10-25T…+08:00"
}
```

与 `manifest-v3.lock.json` 同构（`upstream/source/commit/sha256/bytes/syncedAt`），多 `entries` 计
数用于「表被截断」这类低概率事故的自证。

### 4.2 同步脚本 `service/scripts/sync-capability-catalog.ts`

- `bun scripts/sync-capability-catalog.ts --sforum ~/Code/github/SForum`：读宿主的
  **生成物** `docs/extensions/catalogs/capabilities.md`，而不是正则 Go 源码。理由：宿主自己用
  `--check` 保证「文档 = Go 目录」，解析 markdown 表比解析 Go 字面量稳定，且宿主改字段时
  文档先变形、解析先报错，不会静默错位。
- 解析后校验（任一失败即退出 1 并给中文原因 + 下一步）：行数 ≥ 1 且与表头对齐、`key` 唯一、
  `key` 匹配 `^[a-z][a-z0-9.]*$`、`risk ∈ {low,medium,high}`、`labelZh/labelEn/description` 非空、
  没有多余列。
- `commit` 取 `git -C <sforum> rev-parse HEAD`；`sha256` 取生成 JSON 的字节。
- `--check`：**纯本地**——重算 `catalog.json` 的 sha256 与 bytes 对比 lock；再校验结构
  （排序、枚举、重复、条数）。不联网、不要求宿主检出，所以 CI 稳定。
- 宿主漂移的主动发现放在 `capabilities:verify-upstream`（可选、需要网络）：按 lock 的 `commit`
  从 GitHub 取同一路径原文，重算 sha 并 diff 条目；不进 CI 必跑项（网络抖动不该红），进
  值班清单与月度例检。

### 4.3 解析模块 `service/src/lib/capabilities/catalog.ts`

纯函数、无 IO，服务端与客户端都能 import（`product-view.tsx` 是 client component）：

```ts
export type CapabilityRisk = "low" | "medium" | "high";
export type CapabilityEntry = {
  key: string;
  known: boolean;          // false = 宿主目录里没有这个 key
  risk: CapabilityRisk | null;
  labelZh: string | null;
  labelEn: string | null;
  description: string | null;
};
export function describeCapabilities(keys: string[]): CapabilityEntry[]; // 高→低，未知键垫底，同级按 key
export function summarizeCapabilities(entries: CapabilityEntry[]): {
  total: number; known: number; unknown: number;
  byRisk: Record<CapabilityRisk, number>;
  maxRisk: CapabilityRisk | null;
};
export const CAPABILITY_CATALOG_PROVENANCE: { commitShort: string; syncedAt: string };
```

未知键返回 `known: false` 与 `risk: null`——**绝不**回填 `high`（见 D4）。

### 4.4 公开商品页

`service/src/components/storefront/product-view.tsx` 能力 tab：

- 每行：`key`（mono，保持现状）+ 宿主中文标签 + 等级徽标（`low`=success / `medium`=warning /
  `high`=destructive，配色走现有 token）+ 折叠区「宿主说明（英文原文）」。
- 排序：高 → 中 → 低 → 未知（同级按 key），因为宿主启用审查就是这个顺序。
- 未知键：灰色虚线徽标「未收录」，副文案「不在商城快照（可能由更高版本宿主新增）」。
- 面板说明替换为两句（见 4.6），并保留「安装时由论坛展示，管理员可以逐项拒绝」到列表下方——
  这句仍然成立，只是不再是唯一的信息。
- 侧栏「安装包」卡新增 chip：`maxRisk === "high"` →「含 N 项高风险能力」；仅 `medium` →
  「含 N 项中风险能力」；全 `low` →「均为低风险能力」；`total === 0` → 不渲染。
- 来源行：`能力释义取自 SForum 宿主能力目录（{commitShort}）`，`title` 上给完整 commit 与
  `syncedAt`。

### 4.5 审核台

- `service/src/components/moderation/capability-diff.tsx`：两列（已审快照 / 当前声明）每个 key
  并排显示标签 + 等级徽标；未知键用「未收录」中性徽标。
- `service/src/components/moderation/format.ts`：新增 `capabilityRiskLabel` / `capabilityRiskTone`
  / `summarizeCapabilityKeys(keys)` 的展示包装（复用 4.3 的纯函数，不新写判定）。
- 区块标题补一句：「未审 2 项 · 含 1 项高风险」，紧接着仍写明「任何未审过的能力键都会重新进审」
  ——策略没变，等级只帮审核员排优先级。

### 4.6 文案（zh-CN，精确措辞）

- 能力面板第一句：`来自 v{version} 的扩展清单；标签与等级取自 SForum 宿主能力目录（{commitShort}），
  商城不另行判定。`
- 第二句：`等级描述该能力在宿主侧能碰到什么面，不代表插件质量或是否经过审计。`
- 第三句：`宿主还会按 backend / settings / jobs / mail.provider 推断追加能力，最终授权以论坛启用页为准。`
- 徽标：`低风险` / `中风险` / `高风险` / `未收录`。
- 空集合：保留现有「该版本未声明额外能力。」并追加「宿主仍可能按清单其他字段推断追加」。

### 4.7 契约与数据

- 无 DB 迁移（标签在渲染期解析，不落库）。
- 无 OpenAPI 变更；`contracts/store-api.yaml` 那条注释补一句「展示层用 vendored 目录补标签」，
  `bun run contract:generate` 后 `api-types.ts` 应无 diff。

## 5. 文件清单

**新增**

- `service/src/lib/capabilities/catalog.json`、`catalog.lock.json`
- `service/src/lib/capabilities/catalog.ts`、`catalog.test.ts`
- `service/scripts/sync-capability-catalog.ts`
- 本计划；落地后 `knowledge/decisions/2026-10-25-host-capability-catalog.md`

**修改**

- `service/src/components/storefront/product-view.tsx`
- `service/src/components/moderation/capability-diff.tsx`、`format.ts`
- `service/package.json`、`package.json`（`capabilities:sync` / `capabilities:check`）
- `.github/workflows/ci.yml`（service job 加 `bun run capabilities:check`，排在 Contract drift 之后）
- `knowledge/index.md`（计划表 + 外部依赖表补一行目录来源）
- `knowledge/decisions/2026-10-24-s4-review-flow.md` §4（补指向）

## 6. 验收

- `bun run capabilities:check` 绿；`bun test` 新增用例：已知键标签、未知键 `known:false`、
  高→低→未知排序、`summarize` 计数、`catalog.json` 与 lock 的 sha/bytes 一致、枚举外 risk 被拒。
- `bun run typecheck` 干净；`bun run contract:generate` 后无 diff。
- 视觉证据：商品页能力 tab（含未知键样例）+ 侧栏 chip + 审核台差异，1633×810 与 390×844 各一份。
- 手动核对一条真实产品（`oauth2-provider`）与宿主启用页的标签/等级一致。

## 7. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 快照漂移（宿主改等级 / 新增 key），商城说法过期 | lock + 来源行带 commit；`capabilities:check` 守内部一致；`capabilities:verify-upstream` 按 commit 复核（可选、需网络） |
| 用户把「高风险」读成「这个插件很危险」 | 4.6 第二句明确「授权面等级，不代表质量或审计」；商品页不出现任何「安全 / 不安全」结论 |
| 版本错配（浏览者在跑旧宿主） | 来源行写 commit，不写「当前论坛的判断」；「最终授权以论坛启用页为准」 |
| 宿主先行、商城滞后导致未知键变多 | 未知键灰显 + 中性措辞；不影响闸门；月度例检补 sync |
| 英文 description 混进中文界面 | 默认折叠，标题写「宿主说明（英文原文）」；见 §9 PQ1 |
| 把 vendored 目录误当契约权威 | 注释与文档都写明：结构权威是宿主 Go 目录，本文件只是展示用副本，改契约走宿主 |

## 8. 顺序

1. 目录 + 脚本 + lock + CI（含单测）
2. 公开商品页（列表 / 聚合 / 侧栏 chip / 来源行）
3. 审核台差异
4. 决策记录 + index 更新

三块可独立 review，1 不做完不动 2。

## 9. 待裁（不阻塞计划批准，实施前给一句话即可）

- **PQ1**：宿主 `description` 只有英文。建议**默认折叠显示英文原文**；备选是整段不显示（纯中文界面
  最干净），或等宿主补 `DescriptionZH` 再显示（跨仓，可能很久）。
- **PQ2**：`capabilities:verify-upstream` 要不要进 CI？建议**不进必跑**（网络抖动），进月度例检。
- **PQ3**：风险分级是否最终要进自动发布闸门（低风险新键免重审）？本轮**不动**，若要动另开计划 +
  决策记录 + allowed/denied 全量测试。

## 10. 未验证项

- 宿主 `capabilities.md` 的 5 列结构稳定性：目前 13 行都是 6 个分隔符（已核）；宿主未来加列时解析
  必须报错而不是错位——脚本按「列数必须等于 5」硬校验，该约束在宿主侧没有承诺，属**未验证的
  长期契约**。
- `product-view.tsx` 是 client component，把 13 条目录内联进客户端 bundle 的体积影响未实测
  （量级应 < 4 KB，不引入动态 import）。

## 11. 落地记录（2026-10-25）

按 §8 顺序完成 1–3，第 4 项（决策记录 + index）同轮完成。

**交付物**

- `service/src/lib/capabilities/catalog.json` + `catalog.lock.json`（13 条，宿主 `8662d07`，
  sha256 `c1a456c5b039…`，`docDirty: false`）
- `service/src/lib/capabilities/catalog.ts` + `catalog.test.ts`（10 条用例）
- `service/scripts/sync-capability-catalog.ts`（`--sforum` / `--check`），根与 service 各加
  `capabilities:sync` / `capabilities:check`
- 商品页：标签 + 等级徽标 + 高风险优先排序 + 聚合行 + 侧栏 chip + 来源行 + 两条限定文案 +
  未知键灰显；折叠的「宿主说明（英文原文）」
- 审核台：`capability-diff` 每键两行（key + 标记 / 等级徽标 + 中文标签），两列同序，
  底部补「未审 N 项，其中 M 项高风险」
- `.github/workflows/ci.yml`：`Capability catalog drift` → `bun run capabilities:check`
- `decisions/2026-10-25-host-capability-catalog.md`；`decisions/2026-10-24-s4-review-flow.md` §4
  补「展示层落地、闸门不变」指向

**与计划的偏差**

1. **`format.ts` 未改**：等级与排序全部收在 `lib/capabilities/catalog.ts`，审核台直接 import，
   不在两处各写一份判定（计划 §5 把它列进修改清单，实际不需要）。
2. **侧栏 chip 跟随 `selected` 版本，而不是最新版本**：那张卡说的是「你将要下载的包」，与
   能力 tab（固定最新可见版本）本来就是两件事；混用会把旧版本的等级贴到新版本上。
3. **审核台的视觉证据改用服务端渲染断言**：本地没有管理员会话（`/admin` 302 到登录页），
   `capability-diff.test.ts` 用 `renderToStaticMarkup` 断言标签、等级、排序与未知键文案。
   真机截图待有会话时补。
4. **`capabilities:verify-upstream` 未实现**（PQ2 建议放月度例检，不进 CI）。当前漂移发现靠
   `capabilities:check`（内部一致）+ 人工 sync。
5. **`contracts/store-api.yaml` 的注释没动**：计划 §4.7 说补一句「展示层用 vendored 目录补标签」，
   实际保持原样——契约文件里不描述渲染实现，避免把展示细节写进跨产物契约；来源说明放在
   `decisions/2026-10-25-host-capability-catalog.md` 与本计划。

**验证证据**

- `bun run capabilities:check`：13 entries, lock matches, upstream `8662d07`
- `bun test`：694 pass → 708 pass（+10 目录、+4 审核台渲染），0 fail
- `bun run typecheck`：干净
- 商品页 `oauth2-provider`：SSR HTML 已含「调用宿主 API / 读取用户信息 / 读取本人邮箱地址 /
  低风险 / 高风险 / 最高等级 / 含 2 项高风险能力」；1633×810 与 390×844 截图各一份
  （`tmp/capabilities-tab-1633.png`、`tmp/capabilities-tab-390.png`）
