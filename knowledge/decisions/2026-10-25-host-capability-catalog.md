# 能力标签与风险等级：跟随宿主目录，但只跟随「展示」

Status: accepted
Date: 2026-10-25

## 背景

商品页的能力面板此前只有裸 key（`host.api`、`users.read`）加一句「安装时由论坛展示，管理员
可以逐项拒绝」。`decisions/2026-10-24-s4-review-flow.md` §4 明确把「能力分级」推迟到目录定稿，
并写下重开条件。现在宿主目录已经定稿：`apps/api/app/Support/Capabilities/catalog.go` 有 13 条
`Definition{Key, Risk(low·medium·high), LabelZH, LabelEN, Description}`，导出为
`docs/extensions/catalogs/capabilities.md`，宿主 CI 用 `extension docs generate --check` 保证
「文档 = Go 目录」。

问题变成：商城能不能跟随宿主翻译、判断风险？本地 `oauth2-provider` 的四项能力在宿主眼里是
2 低 2 高，在商城里完全等价——这是信息缺口，不是审美问题。

## 决定

### 1. 唯一来源是宿主的生成物，vendored 成带锁的副本

`service/src/lib/capabilities/catalog.json` 是 `capabilities.md` 表格的逐字段副本，
`catalog.lock.json` 记录 `upstream / source / commit / sha256 / bytes / entries / docDirty /
syncedAt`，与 `manifest-v3.lock.json` 同构。`capabilities:sync -- --sforum <检出>` 生成，
`capabilities:check` 校验，CI 跑 check。

解析 markdown 生成物而不是正则 Go 源码：宿主改列时解析先报错，不会把一列悄悄读成另一列。
`capabilities:check` 只守**本仓内部**一致（不联网、不要求宿主检出），所以 CI 稳定。

### 2. 等级只用于展示与排序，不进发布闸门

`decideReleaseState` 一行未改：任何未出现在 `capabilities_reviewed` 的键仍然重新进审。
等级只决定**阅读顺序**（高 → 中 → 低 → 未知垫底，与宿主启用审查一致）和徽标颜色。
「低风险新键免重审」是政策变更，需要自己的决策记录与全量 allowed/denied 测试，本轮明确不做。

### 3. 未知键没有等级

宿主目录里没有的 key 返回 `known: false, risk: null`，界面显示中性「未收录」，副文案说明
「可能由更高版本宿主新增」。**绝不**因为不确定就回填 `high`——那会把宿主新增的低风险键
显示成危险项，比不显示更糟。

### 4. 三条限定必须与徽标同时出现

- 等级描述该能力在宿主侧能碰到什么面，**不代表插件质量或是否经过审计**；
- 宿主还会按 `backend / settings / jobs / mail.provider` 推断追加能力（`resolve.go`），
  商城只显示**显式声明**；
- 最终授权以论坛启用页为准。

来源行写 commit 短码（`8662d07`）与同步时间。这是「某次宿主提交的目录」，不是「你这台论坛
当下的判断」——公开商品页在商城域名下渲染，浏览者可能还没登录任何论坛。

### 5. 契约与数据不变

`releases[].capabilities` 仍原样透出原始 key 数组；不新增 `/api/v1/capabilities`；无 DB 迁移、
无 OpenAPI 变更。标签在渲染期解析，DB 里不存副本。

## 被否的选项与代价

- **运行时只问宿主**：公开商品页没有宿主上下文，只能得到空面板；要做到论坛内实时覆盖，需要
  宿主新增 bridge/host 面（现在 `hostActions` 只有 `extension.install`），是跨仓改动 + 宿主发版
  节奏问题。宿主一旦提供这个面，应重评混合模式。
- **只深链宿主文档**：零维护，但用户跳出商城，且文档版本与商品声明的版本对不上。
- **未知键按高风险呈现**（fail-closed 展示）：观感保守，代价是把宿主新增的低风险键误标为危险。
- **复算宿主推断**（自己算出会追加哪些键）：语义最完整，但要复制 `resolve.go` 并长期对拍，
  一次规则变更就会静默漂移。
- **把分级接进闸门**：见 §2，属于政策变更，不在本轮。

## 代价与重开条件

- **快照会滞后**：宿主改等级或加 key 后，商城要等下一次 `capabilities:sync`。缓解是 lock 里的
  commit + 界面来源行；**未实现**的是按 commit 从 GitHub 复核的 `capabilities:verify-upstream`
  （计划 §9 PQ2 建议放月度例检，不进 CI 必跑，避免网络抖动变红）。
- **description 只有英文**：默认折叠并标注「宿主说明（英文原文）」。要纯中文界面就得等宿主补
  `DescriptionZH`（跨仓）。
- **浏览者所在论坛可能比快照旧**：来源行写 commit、文案写「以论坛启用页为准」，不冒充实时判断。
- **`capabilities.md` 的 5 列结构不是宿主承诺的长期契约**：解析器按列数硬校验，宿主加列时
  这里会红，需要跟一次 sync 适配。

## 落地位置

- 目录与锁：`service/src/lib/capabilities/catalog.json`、`catalog.lock.json`
- 解析与展示纯函数：`service/src/lib/capabilities/catalog.ts`（`describeCapabilities` /
  `summarizeCapabilities` / `capabilityEntry`）
- 同步脚本：`service/scripts/sync-capability-catalog.ts`
- 商品页：`service/src/components/storefront/product-view.tsx`（标签、徽标、聚合、侧栏 chip、
  来源与限定文案）
- 审核台：`service/src/components/moderation/capability-diff.tsx`（每键标签 + 等级，两列同序）
- CI：`.github/workflows/ci.yml` → `Capability catalog drift`
