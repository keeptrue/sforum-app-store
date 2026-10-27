# 2026-10-27 扩展更新徽章交接

## Changed

- 清单：新增 `includes.adminSurfaces: manifest/admin-surfaces.json`，声明三条
  `list_column`（`sforum.store.admin.updates.{plugins,themes,overview}`，surface
  `contractVersion` 为各自 `@2`，`placementContractVersion` 仍是
  `sforum.component.page.admin.extensions{,.plugins,.themes}@1`），新增
  `permissions: ["extension.view"]` 与 props/result 两个 schema packageFile（两个
  schema 仍是 `@1`）；插件版本抬到 `0.1.1`（props schema 字节变了，同
  `contractVersion` 会被 Core 的 `validateAdminSurfaceUpgrade` 拒 promote，故 surface
  升 `@2`），backend 与 `catalog.mjs` 摘要随之更新。
- 后端 `backend/surfaces.go`（新，458 行）：`InvokeHook` 覆写只接管
  `admin_surface`（其它 HookKind 回退 SDK 注册表），入口先 `Server.Health` 校验运行时
  身份；判定按 `source=builtin`、类型、扩展 ID、版本可解析性过滤，比较基线取
  `max(version, stagedVersion)`；按 100 个一组、最多 1000 资源分块查目录
  （`compat=all` + `platform=all`），总预算 5s，任何一组失败整体失败。
- 后端 `backend/upstream.go`：`catalogQuery.ExtensionIDs` + `normalizedExtensionIDs`
  （去重排序，空集合不发参数），避免同一集合产生两个查询串/两个 ETag。
- 失败语义：只有 **400** 当「旧商城不认识 `extensionIds`」→ accepted 空结果；
  401/403 → `upstream_rejected` 不可重试；404 → 不可重试且文案点名目录路径；
  429/5xx/传输 → 可重试 `upstream_unavailable`；stale 缓存 fail closed。
- 服务端：`service/src/lib/catalog/extension-ids.ts`（新）解析 `extensionIds`
  （逗号分隔、去重排序、≤200 个去重后计数、语法同清单 ID，非法 → 400
  `invalid_query`，空值 → 不过滤）；`query.ts` 接入 `inArray` 过滤并把集合排序后
  计入 fingerprint；`api-types.ts` 与 `contracts/store-api.yaml` 同步参数。
- 前端：`frontend/admin/src/deep-link.ts`（新）只读 `?product=<slug>` 并按
  `^[a-z0-9][a-z0-9-]{1,63}$` 校验；`catalog.ts` 挂载即打开深链详情、抽出
  `applyDetailSelection` 与 `resyncDetailTarget`（target 后到时按真实架构重算版本与
  安装平台，普通点击/搜索/翻页不重置手选版本）。文件 1051 行（HEAD 1021）。

## 证据

- 构建摘要（final build，`sha256sum` 与清单逐字一致，本机实测）：backend
  `9f07867b0db6a02fd3998ce0da7788502b5d4a491dca1ff6ee0cdabd7bfd4beb`；
  `catalog.mjs` `557a9dd068255b83dfb658f4fc0a5dd14ee514ae8582a70e7ce0b3518a2125f7`
  （60,865 B，预算 81,920）；props
  `39aec2530b5aafb508aea6948e791fd3b45bd52a53527bf869f59a090fac6a3c`；result
  `e740a0a438545ac0843411fa1e9fbe28ce3de703da7f54f823f95e48156b6066`；
  `catalog.css` `68026203e7508ef263483d201c5757fd863e474f6226ab5236572976e7a8ddf4`
  （18,101 B 未变，预算 20,480）。
- Promote（dev 环境实况）：插件 `0.1.1`，`active_version_id = 22851`、`enabled`、
  无 staged；运行期发布 revision 841（reason=enable，12 members），
  `plugin_runtime_applied_members` 记录 22851 + 新 `runtime_instance_id`，插件子进程已
  用新产物重启并 ack；`package_digest 6bf70405…`。registry 接受三条 surface 的 `@2`，
  placement 仍按 `@1` 匹配。生产从 `0.1.0`（不含 `adminSurfaces`）升级不受影响；
  只有跑过早期 T3 的 dev 实例会撞旧 `@1` 声明，`@2` 已解决。
- `go test ./...`（`plugin/plugins/sforum.store/backend`）→ `ok … 0.704s`；
  `surfaces_test.go` 17 个用例（15 `TestUpdateSurface*` + 2 `TestInvokeHook*`）。
- `bun test plugin/plugins/sforum.store/frontend/admin/src` → **185 pass / 0 fail /
  1040 expect**（含 `deep-link.test.ts` 的 3 个 describe）。
- 宿主校验 `go run ./cmd/sforum extension validate <package>` → `OK`，
  `permissions: 1`、`v3.platform: admin=3`、`v3.packageFiles: 11`。
- 浏览器 QA（三页徽章、深链、390×844、失败降级）与残余风险见
  `sessions/2026-10-27-extension-update-badges-review.md`（T5，同批产出）。

## Decisions

- `decisions/2026-10-27-update-badges-via-admin-surface.md` —— 复用 Core Admin
  Surface，更新判断留在插件；含失败分档、`extensionIds` 契约、深链与 schema 不对称
  的理由。

## Next

- T5 的浏览器 QA 落地后，把截图与实测结论补进 review handoff；若发现徽章在窄屏挤压
  身份行，优先调 `SFAdminExtensionIdentity` 的换行策略，而不是缩徽章。
- `frontend/admin/src/catalog.ts` 已 1051 行，深链与详情选择可抽成
  `detail-selection.ts`（`applyDetailSelection` / `resyncDetailTarget` / `openProduct`
  的 target 重算），下次改这块前先抽。
- T6 收尾核对（2026-10-27，本仓 knowledge 三文件）**核对无出入**：active `22851` /
  `0.1.1` / `package_digest 6bf70405…`（`extension_versions` 与 `public.extensions`
  实读，`staged` 空、`status=enabled`）；backend `9f07867b…`、`catalog.mjs`
  `557a9dd0…`（60,865 B）、props `39aec253…`、result `e740a0a4…`、`catalog.css`
  `68026203…`（18,101 B）—— 用 `sha256sum` 对 `backend/plugin`、
  `frontend/admin/dist/*`、`schemas/admin-updates.{props,result}.json` 逐字复核；三条
  `list_column` surface `@2`、placement `@1`、权限 `extension.view`、priority 10 与
  `manifest/admin-surfaces.json` 一致。两处指向 T5 review 的引用已是真实文件名
  （`sessions/2026-10-27-extension-update-badges-review.md`，T5 落盘中），没有占位要替换。
  另：promote 记录里的 `revision 841` 是 promote 当时的发布号，T5 的停用/启用 QA 已把
  `plugin_runtime_publications` 推进到 851（同为 enable、12 members、含 22851），不矛盾。

## Open Questions

- 商城未配置时 surface 返回空结果（无徽章、无错误）——本批已批准的行为，不是缺陷：
  未配置不是故障，配置入口在商城插件的设置页。**已知限制**：管理员可能读成「都已
  是最新」。未来可在「商城插件已启用但未配置」时加一次性设置提示，本批 out of
  scope，没有加任何 UI。
- 混合版本场景：旧商城对 `extensionIds` 返回 400 → accepted 空结果，**静默无
  warning**；新商城的 401/403/404 → typed error，页面级 warning + 重试入口，
  429/5xx → 可重试 warning。两者在**徽章位置**都没有徽章，但页面级提示可区分，
  不是「完全不可区分」；暂按可接受处理，待 T5 报告若有更精确证据再校正。
