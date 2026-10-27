# 2026-10-27 商城更新徽章文案交接

## Changed

- 运行时文案（`backend/surfaces.go:434-446`）：surface title zh `商城更新` / en `Store updates`；
  badge zh `商城有新版 vX` / en `Update in store vX`。刻意与 Core 的三态更新语义
  （可升级 / 重启后生效 / 激活后生效）区分：商城只说「商城有新版」，不替宿主断言当前实例能升到哪一档。
- 清单（`manifest/admin-surfaces.json`）：三条 `list_column` 的 `label` `可更新` → `商城更新`
  （:9 / :24 / :39），`contractVersion` `@2` → `@3`（:4 / :19 / :34），`placementContractVersion`
  仍 `@1`。
- 代码声明（`backend/surfaces.go:64 / :70 / :76`）：三条 `contractVersion` 同步 `@3`。宿主按
  `request.GetContractVersion()` 与声明逐字比对（`surfaces.go` 的 InvokeHook 入口），代码不跟就会
  每次都被 `invalid_argument` 拒。
- 测试（`backend/surfaces_test.go`）：`:133` 版本后缀断言改 `@3`；`:301 / :304 / :359 / :543 /
  :552` 文案断言改新文案；`:582 / :608` 请求 `ContractVersion` 改 `@3`。
- **未改** `frontend/admin/src/copy.ts` 的 `updateBadge`：那是商城页自己的目录卡片角标，语境不同，
  保持「可更新至 vX」。`docs/plugin.md`、`plugin/README.md` 讲目录卡片的地方同样未动。

## 关键约束（下次别再撞）

**改 surface `label`（或任何声明字段）必须同时 bump `contractVersion`。** Core 的
`apps/api/app/Support/Extensions/admin_surface_registry.go:391-406` `validateAdminSurfaceUpgrade`
在 `ContractVersion` 相同时做整结构体比较 `old != surface`，而 `Label` 是
`ManifestAdminSurface` 的字段（`v3_platform_types.go:111`）。文案在 Core 眼里不是纯表现层：
同版本改 label，dev 自动 promote 会以
`admin surface registry contract conflicts with the active snapshot: surface … changed without contract version`
失败，并陷入 auto recovery 重试。

不 bump 的替代方案（只改运行时 title）不成立：Core 渲染是 `view.title || surface.label`
（`apps/web/app/utils/admin/adminSurfaces.ts:229`），列头会显示新文案，但失败提示仍用
`surface.label`（`apps/web/app/composables/admin/useAdminListSurfaces.ts:118`），声明与运行时
会不一致。

## 证据

- `cd plugin/plugins/sforum.store/backend && go vet ./...` → 无输出；`go test ./... -count=1` →
  `ok … 1.457s`。
- `bun run manifest:check` → `manifest schema OK: d69501132bd6aeac2e063a4331a59da6faf7ce62135aa0af7ad9eca0314c9b8e`。
- `bun run test`（service）→ `826 pass / 0 fail / 2837 expect`，70 文件 50.94s。
- dev watcher promote（`/tmp/ops-api-dev3.log`，06:31:23）：`dev auto: extension promoted`，
  digest `11942c15a7c449dccb538522cd81daa7b8c903e02094cf3f1fd36c9a8199c260`。DB 实读：
  `extensions.sforum.store` → `enabled`、`active_version_id=22897`、`staged_version_id` 空；
  `extension_versions` 22897 → `0.1.1` / 同摘要；`plugin_runtime_publications` revision 910
  （`upgrade`、12 members）；`plugin_runtime_applied_members` 22897 的 `runtime_instance_id`
  `95005e4cf5fb9b007f0206992be61f8a`。
- 制品复核：`storage/extensions/sforum.store/0.1.1/11942c15…/manifest/admin-surfaces.json`
  三条 `@3` + `label 商城更新`；同目录 `backend/plugin` 含 `…updates.{plugins,themes,overview}@3`
  与 `商城有新版 v` / `Update in store v`。
- `sforum.extension.json` 的 backend digest 由 watcher 构建时写回（`581c5ce86ab1…`），
  属预期，未手改。

## Next

- 三页最终渲染文案由 Lead 在浏览器确认（本批只保证单测、清单检查与 promote 落库）。
- `knowledge/index.md`、`decisions/2026-10-27-update-badges-via-admin-surface.md` 里仍写 surface
  `@2`，那两处本轮由其他人改，未动；下次谁先收尾谁顺手对齐到 `@3`。

## Open Questions

- 每改一次 label 文案都要再 bump 一次 surface 版本，是 Core 现行规则的直接代价。若产品希望
  label 可自由改文案，需要 Core 把 `Label` 排除出 `validateAdminSurfaceUpgrade` 的结构体比较——
  那是核心仓的决策，不在本仓范围，本批不发起。
