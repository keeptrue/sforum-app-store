# 决策：更新徽章走 Admin Surface，更新判断留在商城插件

Status: accepted
Date: 2026-10-27
Related: Core 仓 `SForum` 的
`knowledge/decisions/2026-10-27-extension-update-badges-admin-surface.md`（宿主侧
`links` 契约与渲染位）、`2026-10-24-app-store-core-install-primitive.md`（Core 不
承载商城目录）、`2026-10-26-platform-availability.md`（`compat` / `platform` 语义）

## 背景

管理页此前只能在点开产品详情后才看到版本信息；管理员想知道「我装的这些扩展有
没有更新」，得逐个扩展去商城搜一遍。Core 不认识商城，也不该认识；商城插件又拿
不到宿主扩展列表行的渲染入口。于是要回答两件事：**谁判断更新**，以及**判断结果
怎么落到宿主列表行上**。

## 决定

1. **三条 `list_column` surface，共用一套判定**：id
   `sforum.store.admin.updates.{plugins,themes,overview}`，surface 自己的
   `contractVersion` 为 `sforum.store.admin.updates.{plugins,themes,overview}@2`
   （registry/invoke 用），`placementContractVersion` 仍是
   `sforum.component.page.admin.extensions.plugins@1`、`…themes@1`、`…extensions@1`
   ——两层版本不同源，placement 不随 surface 升版。三条共用 handler
   `sforum.store.admin.updates`、`propsSchema sforum.store.admin.updates.props@1`、
   `resultSchema sforum.store.admin.updates.result@1`（两个 schema 仍是 `@1`），
   `operation: query`，`permission: extension.view`，`priority: 10`。声明放在
   `manifest/admin-surfaces.json`，由清单 `includes.adminSurfaces` 引入。
   之所以从 `@1` 升到 `@2`：props schema 顶层 `additionalProperties` 由 false 改为
   true，字节变了；Core 的 `validateAdminSurfaceUpgrade`
   （`apps/api/app/Support/Extensions/admin_surface_registry.go`）在同一
   `contractVersion` 下会比对声明与所引用 schema 的 digest，内容变了却不升版本会被
   判成 `ErrAdminSurfaceRegistryConflict` 并拒绝 promote。schema 文档版本
   （`…props@1` / `…result@1`）不跟 surface 契约版本走，所以仍是 `@1`。
2. **判定只看「商城里有没有比已装更新的版本」**：跳过 `source=builtin`（内置跟
   Core 发布，商城不参与升级）、非 `plugin`/`theme`、非法扩展 ID、版本不可解析的
   资源；比较基线取 `max(version, stagedVersion)`——已经暂存了更新版本时它「已经
   到手」，不该继续提示更新。可升级判定与目录卡片共用 `mapping.go` 的
   `updateAvailable`，两处不会各说各话。
3. **批量查询而不是全量拉目录**：按 100 个 ID 一组、最多 1000 个资源分块请求目录
   的 `extensionIds` 参数，并固定 `compat=all` + `platform=all`——更新判断不能被
   宿主版本或架构把候选藏掉（否则异架构/旧宿主上的新版本会显示成「已是最新」）。
4. **失败语义按状态码分档**（`surfaces.go`）：只有 **400** 视为「旧商城不认识
   `extensionIds`」，返回 accepted 空结果；401/403 返回 `upstream_rejected`
   （不可重试，提示核对商城地址与访问权限）；404 同样不可重试，文案点名目录路径；
   429 与 5xx/传输失败返回可重试的 `upstream_unavailable`；5s 总预算超时返回
   `DEADLINE_EXCEEDED`；上游故障时若只能拿到 stale 缓存，一律 fail closed，不把旧
   快照当成「已是最新」。任何一组失败都整体失败，不返回半张表。
5. **服务端新增批量过滤 `extensionIds`**：逗号分隔，去重排序，最多 200 个（按去重
   后计数），语法与清单扩展 ID 一致（`^[a-z0-9][a-z0-9._-]{0,159}$`）。非法 ID 直接
   400 `invalid_query`（拼错的 ID 会悄悄变成「没有更新」，宁可报错）；空值/缺省表示
   不过滤，而不是空结果。`inArray` 只在集合非空时拼条件，fingerprint 也按排序后的
   集合计算，保证同一集合只有一个 ETag。
6. **深链回到商城详情**：徽章链接是
   `/extensions/sforum.store/pages/catalog?product=<slug>`（slug 经
   `url.QueryEscape`，只出现在查询串里）。管理页挂载时读一次 `?product=`，校验
   slug（`^[a-z0-9][a-z0-9-]{1,63}$`）后打开既有详情弹窗；不写 history、不改卡片
   点击的 URL。详情与目录并行请求，target 后到时用 `resyncDetailTarget()` 按真实
   架构重算版本与安装平台；普通点击、搜索、翻页不会重置管理员手选的版本。
7. **schema 有意不对称**：props 顶层 `additionalProperties: true`（保留 9 条
   required），因为输入是宿主逐字段发送的通用载荷，Core 以后加字段不该让旧插件整条
   surface 失败；result 保持 `additionalProperties: false`，因为输出是本插件自己的
   契约，必须严格。
8. **Hook 分发只接管自己的家族**：`InvokeHook` 覆写只处理 `admin_surface`，其它
   `HookKind` 回退 SDK 注册表分发；覆写会 shadow SDK 的运行时上下文校验，所以入口
   先调一次 `Server.Health`，身份不匹配时绝不进入业务代码。

## 放弃的方案

- **Core 加商城专用接口或表**：违反 out-of-tree 边界，Core 不该知道商城。
- **Core 定时轮询商城做更新检查**：Core 不产生商城出站流量，也不该持有商城地址。
- **在插件自己的管理页里画更新标记**：徽章要出现在宿主的扩展列表行上，插件页面
  拿不到那些行。
- **一次拉全目录再本地比对**：目录规模、分页与 ETag 成本都不可控；批量
  `extensionIds` 才是精确问法。
- **所有 4xx 都当「旧服务」返回空结果**：会把 401/403/404/429 这类需要运维介入的
  故障伪装成「没有更新」——这正是 review 里被推翻的第一版实现。

## 后果

- 徽章依赖商城可达：未配置商城地址时返回空结果（不是错误，也不出 warning），列表
  照常显示；这是已批准的取舍，不是缺陷。
- 每次页面加载对每条 surface 调用一次，按 100 分块；1000 个资源最多 10 次上游请求，
  总预算 5s。
- 旧商城（不认 `extensionIds`）返回 400 → accepted 空结果、静默无 warning，属可接受
  的降级；而 401/403/404 是不可重试的页面级 warning，429/5xx/传输失败是可重试
  warning。也就是说：**徽章位置都无徽章，但页面级提示能区分「旧服务」与「真故障」**。
- 深链让「从徽章点进详情」与「从卡片点进详情」走同一个弹窗，减少一套 UI。
- `frontend/admin/src/catalog.ts` 现在 1051 行（HEAD 1021 行），深链与详情选择逻辑
  继续堆在单文件里，属 residual risk，后续按职责抽取。

## 重开条件

- Core 提供跨页聚合或按更新状态排序的查询面时，重新评估是否需要 surface 之外的通道。
- 商城提供签名更新 feed（一次请求拿到全部已装扩展的最新版本）时，可省掉分块查询。
- 需要在非管理端（通知、公开页、AI 工具）展示更新状态时，走数据面申请流程。

## 证据

- 契约：`contracts/store-api.yaml`（`extensionIds` 参数）、
  `plugin/plugins/sforum.store/manifest/admin-surfaces.json`、
  `schemas/admin-updates.props.json` / `admin-updates.result.json`。
- 后端：`backend/surfaces.go`（458 行）、`backend/upstream.go`（`ExtensionIDs`、
  `normalizedExtensionIDs`）；测试 `backend/surfaces_test.go` 共 17 个用例（15 个
  `TestUpdateSurface*` + 2 个 `TestInvokeHook*`）。
- 服务端：`service/src/lib/catalog/extension-ids.ts`、`query.ts`、
  `query.test.ts`（新增 extensionIds 用例）、`api-types.ts`。
- 前端：`frontend/admin/src/deep-link.ts`、`deep-link.test.ts`、`catalog.ts`。
- 构建产物 digest（final build，本机 `sha256sum` 与清单逐字一致）：backend
  `9f07867b0db6a02fd3998ce0da7788502b5d4a491dca1ff6ee0cdabd7bfd4beb`；`catalog.mjs`
  `557a9dd068255b83dfb658f4fc0a5dd14ee514ae8582a70e7ce0b3518a2125f7`（60,865 B）；
  props `39aec2530b5aafb508aea6948e791fd3b45bd52a53527bf869f59a090fac6a3c`；result
  `e740a0a438545ac0843411fa1e9fbe28ce3de703da7f54f823f95e48156b6066`；css
  `68026203e7508ef263483d201c5757fd863e474f6226ab5236572976e7a8ddf4`（18,101 B
  未变）。
- Promote（dev 环境实况）：插件 `0.1.1`，`active_version_id = 22851`、`enabled`、
  无 staged；运行期发布 revision 841（reason=enable，12 members），
  `plugin_runtime_applied_members` 记录 22851 + 新 `runtime_instance_id`，说明插件
  子进程已用新产物重启并 ack；`package_digest 6bf70405…`。registry 接受三条 surface
  的 `@2`。生产从 `0.1.0`（不含 `adminSurfaces`）升级不受影响；只有跑过早期 T3 的
  dev 实例会撞旧 `@1` 声明，`@2` 已解决。
- 验证：`go test ./...`（backend）ok；`bun test plugin/plugins/sforum.store/frontend/admin/src`
  → 185 pass / 0 fail；宿主 `sforum extension validate` → OK（`permissions: 1`、
  `v3.platform: admin=3`）。
- 浏览器 QA 与残余风险见 `../sessions/2026-10-27-extension-update-badges-review.md`。
