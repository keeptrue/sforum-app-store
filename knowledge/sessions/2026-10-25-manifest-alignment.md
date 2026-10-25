# 2026-10-25 清单契约对齐（热交接）

## 这一轮做了什么

商城对 `sforum.extension.json` 的解析从「手写 7 字段子集」改成「宿主 JSON Schema + 少量语义差量」，
并把归档边界、约束求值、清单元数据落库展示一起对齐。决策记录：
`knowledge/decisions/2026-10-25-manifest-contract-alignment.md`。

### 结构层

- `service/src/lib/detection/schema/manifest-v3.schema.json`：宿主 schema 的逐字节副本
  （88,407 B，sha256 `d6950113…c9b8e`，SForum commit `10c2b21e8`）。
- `service/src/lib/detection/schema/manifest-v3.lock.json`：commit + sha256 + bytes。
- `service/scripts/sync-manifest-schema.ts`：`manifest:sync --sforum <path>` / `manifest:check`。
- `service/src/lib/detection/schema.ts`：ajv Draft 2020-12 编译一次；`semver` format 用与宿主
  `validateSemver` 相同的严格正则（`detection/semver.ts`），两个 route-mutable pointer format
  注册为宽松（残余差异，见决策记录）。

### 解析与边界

- `detection/manifest.ts`：schema → 归一化 → 语义（id 81、严格 semver、URL/email、backend 四元组、
  主题禁声明、`requiresFeatures`、`packageFiles`）→ 扩展后的 `ExtensionManifest`
  （description/url/author/langs/permissions/requiresFeatures/backend/packageFiles）。
- `detection/zip.ts`：清单必须在根（仅子目录时报 `manifest_not_at_root`，根+嵌套时忽略嵌套，
  与 `ReadArchive` 一致）、4096 条目、拒 symlink / 重复条目 / 含 `..` 路径、`packageFiles` 摘要核对。
- `lib/semver-constraint.ts`：Masterminds 约束解析（`,`、`||`、`!=`、`=`），`catalog/compat.ts`
  只保留 host 版本口径并 re-export；`catalog/query.ts` 用解析结果判可见性。

### 落库与展示

- `release_versions` 新增 `manifest_description` / `manifest_url` / `manifest_author_name` /
  `manifest_author_url` / `manifest_langs`；迁移 `drizzle/0012_vengeful_sally_floyd.sql`。
- `github/sync.ts` 写这五列（author email 校验后丢弃，不落库）。
- `contracts/store-api.yaml` 的 `ReleaseVersion.manifest` + `ManifestLocale`，已重生成
  `api-types.ts`。
- 前台 `product-view.tsx`：facts 增「清单作者 / 项目主页 / 清单语言」，overview 顶部增「清单简介」
  （作者、主页、语言、zh-CN 文案）。
- 审核台 `moderation/version-table.tsx`：新增「清单」列（作者 + 简介截断），读模型
  `DashboardVersion` 增可选 manifest 字段。

### 夹具与命令

- `service/test/fixtures/manifest/`：16 个 fixture + `cases.json`。
- `service/scripts/manifest-conformance.ts`：默认跑商城解析器；`--host` 用插件目录的
  `go run ./cmd/validate-manifest`（replace 指向同级 SForum 检出）逐条对拍。
- root/service 新增 `manifest:sync` / `manifest:check` / `manifest:conformance`。

## 验证证据

- `bun run manifest:conformance` → `manifest conformance OK: 16 fixtures`。
- `bun run manifest:conformance --host` → `OK: 16 fixtures, 16 host runs`（宿主 schema + 语义校验
  与商城 verdict 全一致）。
- `bun run manifest:check` → digest 与 lock 一致。
- `bun run typecheck` → 通过。
- `bun run test` → 672 pass / 0 fail（迁移后重跑 download 相关 55 项通过）。
- `bun run build`（`bun --bun next build`）→ 通过（ajv 在 server bundle 里可用）。
- `bun run seed:dev` → 7 versions 写入，含 manifest 元数据（markdown-plus 1.4.2 带 zh-CN）。
- 视觉：`tmp/manifest-product-1633-full.png`（1633×810 视口、整页 1633×1701）与
  `tmp/manifest-product-390.png`（390×844@3）。确认「清单简介」块、作者/主页/语言换行正常，
  facts 9 格在 1633 下是 3×3、无溢出；390 下三行堆叠、无横向滚动。

## 未完成 / 下一步

- 审核台版本表的「清单」列只有源码与类型证据，没有截图：需要管理员会话才能打开
  `/moderation`（本地未走 setup 流程）。下一步补一张 1633×810 的审核台截图。
- 390×844 下产品页的 Tab 条本来就会横向截断（「声明的能力 3」被切掉），是既有问题，不属于本轮；
  若要修，单独开一条 UI 任务。
- `plugin/` 侧未改：`mapping.go` 对新增字段天然容忍（不加 `DisallowUnknownFields`），插件管理页
  不展示 manifest 元数据。
- 残余差异（route-mutable pointer 预算、includes 合并后的二次 schema 校验、capabilities 不按宿主
  目录硬拒、单清单 1 MiB 上限、历史版本不回溯）都写在决策记录里，重开条件也在那里。
