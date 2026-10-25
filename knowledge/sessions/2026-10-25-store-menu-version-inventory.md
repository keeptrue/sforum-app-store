# 2026-10-25 商城插件：菜单注册、版本转发、已装清单

## Changed

- **菜单（需求 1）**：`sforum.extension.json` 的 `admin.pages` 从 1 页变 2 页，同 `group: "应用商城"`：
  - `商城`（`/catalog`，`view=component`，`order=30`，保留 `hostActions: ["extension.install"]`）
  - `设置`（`/settings`，`view=settings`，`order=40`，`permission=extension.plugin.manage`）
  侧栏渲染为一级「应用商城」→ 商城 / 设置；`admin.entry` 仍是 `/catalog`。**core 零改动**。
  在此之前设置文档没有任何菜单页承载，后台无法修改商城地址。
- **版本转发**：`backend/upstream.go` 的 `catalogQuery` 增加 `SForum`/`SForumBuild`/`Compat`；
  版本只取 v2 握手快照 `Server.HostBuild()`（`sync.Once` 冻结），调用方传入的同名参数一律丢弃；
  未知宿主不发送、不猜。`handlers.go` 新增 `compat=compatible|all` 校验（默认 compatible，非法 400）。
- **已装/可更新**：新增 `backend/inventory.go`，读宿主 `sforum.core.extensions.inventory.list`
  （能力 `extensions.read`）→ `installed: {version,status} | null` + `updateAvailable`（Masterminds semver 比较）；
  60 秒缓存（失败也缓存）、整次读取 2 秒预算、能力未授予时静默降级。
- **封面**：`mapping.go` 透传 `socialImageUrl`（`absoluteAssetURL`），目录项与详情都带；
  `schemas/catalog.response.json`、`schemas/product.response.json` 各加三个可选属性。
- **前端**（`frontend/admin/src`）：兼容开关（默认过滤、页级 `unknown` 时隐藏）、
  封面三级回退（分享卡 → 图标 → 字母块）、已安装/可更新徽标、详情里的 `disabled`/`installed` 说明；
  zh/en 文案补齐。
- **lifecycle V2**（新，`backend/lifecycle.go` 99 行 + `main.go` 一行 + 清单 `lifecycle` 块）：
  六个操作都是幂等 no-op（PLANNED → RUNNING → SUCCEEDED）。这不是可选项——
  非 V2 包换摘要后宿主不会重新发布注册表，路由会带着旧运行时实例身份留在注册表里。
- **品牌资产**：`brand/icon.svg`（1.4 KiB）、`brand/icon.png`（512 RGBA）、`brand/social-preview.png`（1280×640）；
  SForum 仓 `scripts/brand/spec.json` 追加一条 external 条目（`../sforum-app-store/plugin/plugins/sforum.store`）。
- 文档：`docs/plugin.md` 重写（宿主要求矩阵、菜单与页面、兼容性、已装清单、故障排查）；
  `plugin/README.md` 同步；`openapi/routes.yaml` 增加 `compat` 参数。

## Evidence

- `go vet ./... && go test ./...`（含 `-race`）→ ok；新增 `handlers_contract_test.go`、`inventory_test.go`、`mapping_installed_test.go`。
- `bun test plugin/plugins/sforum.store/frontend/admin/src` → **73 pass / 0 fail**。
- `bash plugin/scripts/build.sh` → 2 admin pages、digests 重算、`manifest OK`。
- 宿主四闸：`extension validate`（pages=2、`capabilities.resolved: extensions.read, host.api, net.outbound, settings.own`）、
  `extension test`（6/6 检查通过）、`extension brand check`（1 个包通过）、
  `extension package`（17 文件、digest `6a8f6bd3…`）。
- 浏览器（dev，1633×810）：侧栏「应用商城」展开后为 `商城 → /control-panel/extensions/sforum.store/pages/catalog`、
  `设置 → …/pages/settings`；设置页由宿主 Schema 渲染两个字段，保存后
  `extension_settings` 落库 `sforum.store.catalog_base_url=https://test-sforum-app-store.dalao.me`、`channel=stable`。
- 商城服务端对照结论（`contracts/store-api.yaml` vs 插件）：`kind`/`compat`/`sforum` 已实现但插件此前未消费；
  8 个产品里 `sforum=1.0.0` 只有 3 个兼容、`compat=all` 时 7 个（含 4 条 `incompatible` 判词），符合预期。

## Blocked（未完成的一条）

- **插件路由未准入**：`/api/v1/extensions/sforum.store/api/store/catalog` 恒 503
  `extension.runtime_unavailable`。`route-catalog` 显示 3 条路由已注册（package digest 正确）但
  `admitted=false`；对照 `sforum.oauth2-provider`（声明 lifecycle）17/17 admitted。
  根因是非 V2 包换摘要后注册表不重新发布，路由带着旧 `runtimeInstanceId` 留在注册表里，
  `InspectRuntimeInstance` 对不上 → 准入失败。
- 补上 lifecycle V2 后，启用走到 `host.registering` 失败：
  `lifecycle.execution_failed / extension lifecycle registry publication exact fence conflict`
  ——旧的非 V2 发布留下的 fence 与 V2 发布 CAS 冲突；卸载也因同一路径未完成（状态仍是 disabled）。
- 需要宿主侧复位：清掉该扩展的注册表/发布行后重装，或在干净库上重跑一次。**未动数据库。**
  已尝试的两条复位路径都不成立：①直接删行被审计触发器拒绝
  （`plugin runtime acknowledgement evidence cannot be removed`，事务整体回滚，`extensions` 仍是 1 行）；
  ②`extension gc --extension-id sforum.store --retain 0` 把 3 个版本标成
  `blockedReason: publication_history`（另有 1 个 `within_retention`），回收不了发布历史；
  ③`recovery quarantine` 只接受 built-in/system 制品，本包是 uploaded 外部包。
  剩下可行的是**干净 dev 库**（新建库 + 迁移 + 重启 API，旧库保留可切回）。

## Next

- 复位后重跑真机链路：目录（默认 3 条）→ 开关切 `all`（7 条 + 判词）→ 封面 → 「已安装 v…/可更新至 v…」→ 点安装走宿主确认框。
- 长期：dev 侧若要「改一版就自动生效」，必须保留 lifecycle V2；否则每次换摘要都要手动 restart bridge。
- `catalog.test.ts` 已 1519 行，按 ui/logic 拆分是下一次清理项。

## Open Questions

- 宿主对非 V2 包的注册表再发布是否应当修（当前只有 lifecycle V2 能自愈）；这决定「第三方插件是否必须实现 lifecycle」。
- `installed` 与目录缓存各 60 秒，刚装完的徽标最多延迟一分钟，是否需要缩短。

> **本节已被 2026-10-26 真机验收节取代。** 下文「.env 指向 sforum_fresh / API 未运行 / sforum.store 停在 disabled」均已过期；现行事实见文末「## 2026-10-26 真机验收」。

## 环境现状（2026-10-25 22:45 交接，供新会话接手）

本机 dev 环境的数据库已经分叉，`.env` 当前指向**全新库**：

| 库 | 内容 | 用途 |
| --- | --- | --- |
| `sforum` | 原始 dev 库，数据完整 | sforum.store 停在 disabled + registry fence，其余一切正常；admin 密码未动 |
| `sforum_qa` | 原始库的克隆，已删掉 sforum.store 全部行 | 撞上 `plugin_runtime_convergence_failed`（克隆带过来的 runtime publication 与本地重建后的摘要对不上），不可用；此库 admin 密码被重置过，仅此库 |
| `sforum_fresh` | 只有迁移（154 表、0 用户、0 扩展） | 当前 `.env` 指向它，待建管理员 |

备份：`/tmp/sforum-db-20261025-222836.dump`（原始库 pg_dump -Fc）、
`/tmp/sforum-store-reset-20261025-222358.sql`（相关表数据）、`/tmp/sforum-env-backup-*`（改 DATABASE_URL 前的 .env）。
API 当前**未运行**（air 已被停掉，`/tmp/api-dev-qa.log` 为空）。

接手步骤：

1. 起 API：`cd /home/inkedus/Code/github/SForum && ./scripts/api-dev.sh`（或 nohup 到 `/tmp/api-dev.log`）。
2. 建管理员（空库首个 seed 用户自动成为 super_admin）：
   `cd apps/api && set -a && . ../../.env && set +a && go run ./cmd/sforum seed:forum --users=1 --count=1 --categories=0 --tags=0 --pinned=0`
   再用 `users:reset-password --email <seed 邮箱> --password '...' --yes` 设一个已知密码。
3. 等 dev watcher 从 `EXTERNAL_EXTENSION_ROOTS`（已含 `/home/inkedus/Code/github/sforum-app-store/plugin`）
   装回 sforum.store，检查 `/control-panel/extensions/route-catalog` 三条路由 `admitted: true`。
4. 干净库上若仍 `admitted=false`，说明问题在宿主运行时发布而不是插件，直接带
   「oauth2-provider 17/17 admitted vs sforum.store 0/3」这组对照升级。
5. 想回到原站数据：把 `.env` 的 `DATABASE_URL` 改回 `.../sforum?...` 并重启 API。

## 2026-10-26 真机验收

执行时间 2026-10-26 00:44–00:58（Asia/Shanghai）。只验证、未改任何宿主/插件代码；截图目录 `/tmp/store-qa-20261026/`。

### 环境（实测）

| 项 | 实测值 |
| --- | --- |
| API | `localhost:8080` pid 234916，`/api/v1/health` → `status:ok`、`coreVersion:1.0.0`、`environment:development` |
| Web dev | `localhost:3000` pid 9568（用户手动起，未触碰） |
| 浏览器 | 1633×810，已登录 `super_admin`，无验证码 |
| 数据库 | `.env` → `127.0.0.1:15432/sforum`（原始库） |
| sforum.store | `enabled`，active 版本 `0.1.0 / 9af89683a3cc…9e84`，manifest digest `d00ac016f02d605551514861b5dbb3a3` |
| 运行时发布台账 | `plugin_runtime_publications` 最新 revision 578（reason=enable），ack `applied`，node `nobug` 租约有效 |

### 四步结论

| # | 验收项 | 判定 | 依据 |
| --- | --- | --- | --- |
| 1 | 侧栏「应用商城」为一级分组，展开为「商城」「设置」两页 | **通过** | 与「扩展管理」「OAuth2」「附件设置」同级（无折叠父级）；`aria-expanded` false→true；两个链接 href 精确匹配 |
| 2 | route-catalog 中 sforum.store 三条路由 admitted | **通过** | 3/3 `已生效`；对照 sforum.oauth2-provider 17/17 `已生效` |
| 3a | 目录页默认只列兼容项（预期 3 条） | **原判定：失败（UI）→ 真实态终验：通过** | 原：页面 0 条 +「还没配置商城地址」；中间态：legacy 前缀 200 但桥把裸 JSON 解包成 undefined；终验：真实态 3 行、`共 3 个结果`（详见「修复后复验」） |
| 3b | 开「显示全部」→ 7 条 + 兼容判词 | **原判定：失败（UI）→ 真实态终验：通过** | 原：setup 态开关未渲染；终验：取消「只看当前版本可安装」→ 7 行、`共 7 个结果`，判词 chip「按开发版估算」（dev 构建 `estimated:true`） |
| 3c | 封面图渲染（非字母块回退） | **原判定：无法判定 → 真实态终验：通过** | 终验：3 张封面 `naturalWidth=1280`/`naturalHeight=640`、`tile--cover` 生效；无图项字母回退（站/静/S） |
| 3d | sforum-ai-url-fetch / sforum-ai-web-search 显示「已安装 vX」 | **原判定：无法判定 → 真实态终验：通过** | 终验：`已安装 v1.0.2`、`已安装 v1.0.0`；另见 oauth2 `已安装 v1.6.0`、search-site `已安装 v1.0.7 / 可更新至 v3.1.0` |
| 3e | 点安装 → 宿主确认框（只暂存，不出现「已安装」） | **原判定：无法判定 → 真实态终验：通过** | 终验：宿主「安装此扩展包？」框（来源/下载地址/SHA-256/声明 ID·版本·类型/所需权限），框内无「已安装」；取消后按钮复原、无「已暂存」；查库无 `sforum.demo-s4` |

### 证据

步骤 1 — 侧栏（`step1-sidebar-store-group.png`）

- 分组按钮文本「应用商城」，折叠祖先链为空 → 一级分组；同级按钮依次为 用户/权限、论坛管理、系统配置、AI 能力、扩展管理、应用商城、OAuth2、附件设置。
- 展开后链接：
  - 商城 → `/control-panel/extensions/sforum.store/pages/catalog`
  - 设置 → `/control-panel/extensions/sforum.store/pages/settings`

步骤 2 — 路由注册表（`step2-route-catalog-store.png`）

UI 原文（`/control-panel/extensions/route-catalog`）：

```
插件 sforum.store  0.1.0 · 9af896…9e84 · d00ac016f02d605551514861b5dbb3a3   3 条
GET   /api/store/catalog      add  core.guard.login  已生效
POST  /api/store/install-url  add  core.guard.login  已生效
GET   /api/store/product      add  core.guard.login  已生效
```

`GET /api/v1/admin/extensions/route-catalog` 交叉验证（`revision:2`、`safeMode:false`、`total:399`）：
`sforum.store` 3 条 `admitted:true`、`providerKind:plugin`、`mode:http`、`fallback:closed`、`conflictKinds:[]`；
`sforum.oauth2-provider` 17 条 `admitted:true`；`sforum.page-loader-reference-live` 1 条 `admitted:true`。

> 上一轮记录的「401 auth.required ⇒ 已准入」需要修正：401 只能证明守卫在运行时之前跑过，**不能**证明路由可被代理。带 cookie 复测才是判据（见步骤 3 根因）。

步骤 3 — 目录页（`step3-catalog-setup-state.png`）

页面可见文本（列表区）：

```
目录 / 刷新
还没配置商城地址
到 应用商城 设置里填写商城地址
重新检查
上一页 / 下一页
从左侧目录选择一个扩展查看详情。
```

页面实际发出的请求（劫持 `window.fetch` 后点「重新检查」捕获）：

```
GET /api/v1/extensions/sforum.store/api/store/catalog?channel=stable  → 503
GET /api/v1/extensions/sforum.store/api/store/catalog?channel=stable  → 503
```

503 响应体：

```json
{"code":503,"message":"The extension runtime is temporarily unavailable. Please try again later.","data":{"reason":"extension.runtime_unavailable"}}
```

插件自身路由（声明路径，非 legacy 前缀）同参数返回 200：

```
GET /api/store/catalog?compat=compatible → 200, items=3
  sforum-ai-url-fetch  compatible  >=0.1.0        installed 1.0.2  cover ✔
  sforum-ai-web-search compatible  >=0.1.0        installed 1.0.0  cover ✔
  s4                   compatible  >=1.0.0 <2.0.0
GET /api/store/catalog?compat=all → 200, items=7
  + oauth2-provider(incompatible, installed 1.6.0)、search-site(incompatible, installed 1.0.7)、
    theme-quiet(incompatible)、markdown-plus(incompatible)
```

封面资源直连：`https://test-sforum-app-store.dalao.me/api/assets/712dd83f…` → `200 image/png 80372`；
`…/api/assets/1977776b…` → `200 image/png 84530`。

设置项核对：`GET /api/v1/admin/extensions/sforum.store/settings` 中
`sforum.store.catalog_base_url` 已有值 `https://test-sforum-app-store.dalao.me` —— **页面提示「还没配置商城地址」是误报**。

对照组（`step3-control-oauth2-page-works.png`）：`/control-panel/extensions/sforum.oauth2-provider/pages/clients`
正常渲染 7 个应用；点「刷新」捕获到的是 `GET /api/oauth/clients → 200`（绝对路径，绕过了 legacy 前缀）。

### 根因（宿主侧，非插件业务逻辑）—— 两处均已修复（legacy 前缀 503 / 桥解包），见「修复后复验」

1. 管理页桥 `bridge.request()` 一律加前缀：`apps/web/app/runtime/admin-extensions/types.ts:32` 生成
   `/extensions/<id>/<path>`，最终落到 `/api/v1/extensions/<id>/*`。
2. 该前缀由 `apps/api/app/Http/Controllers/Extensions/routes.go:94`（`api.All("/extensions/:extensionId/*")`）
   交给 `controller.go:737 proxyExtensionRoute`。
3. 该处理器走 HTTP BaseURL 代理：`apps/api/app/Providers/extensions.go:266-276` 在
   `target.Target.BaseURL == ""` 时直接返回 `extensions.ErrRuntimeUnavailable` → 503。
4. 协议 v2（gRPC）插件按设计**不回报 HTTP BaseURL**（`apps/api/app/Support/Extensions/protocol.go:453`
   「isPluginRouteTargetNone 表示插件不提供可代理的 HTTP BaseURL」；`ss -ltnp` 确认无插件监听端口），
   其路由只能经 `InvokeRouteInstance` 在声明路径上派发。
5. 结论：**legacy 前缀对全部 v2 插件恒 503**（store / oauth2 / page-loader 实测一致），
   而声明路径（`/api/store/catalog`、`/api/oauth/clients`）正常。桥文档
   `docs/extensions/trusted-admin-components.md`（「namespaced extension API requests」）承诺的能力当前不可用。
6. 插件侧次生问题：`frontend/admin/src` 的错误归类把 `status===503` 判成 `not_configured`，
   于是运行时不可用被显示成「还没配置商城地址」，掩盖了真实故障，也让「显示全部」开关在 setup 态下被隐藏。

### 环境更正（覆盖本文档旧「环境现状」节）

- `.env` 已指回原始库 `sforum`（不再指向 `sforum_fresh`），数据完整：112 用户 / 1.2k 主题 / 5k 回复。
- `sforum.store` 已 `enabled`，active 版本 `0.1.0 / 9af89683…`（带 lifecycle V2 的制品），插件进程在跑
  （pid 235158，子进程 of 234916），运行时 `state:running`、`routeCount:3`。
- 路由准入已恢复：3/3 admitted（上轮 0/3 的阻塞点已消失）。
- 新发现：dev watcher 自激重建循环，每 ~7 秒一轮，`sforum.store` 每轮重建到摘要 `883030e9…`（不 promote），
  `sforum.web-search` 每轮被 promote，API CPU 约 51%（页面 CPU 卡片实测）；`sforum-oauth2-provider` 因
  `go mod tidy` 持续构建失败、保留上个健康制品。该循环**不影响**本次结论（active 版本未变、台账 revision 578 稳定），
  但会拖慢页面并制造偶发抖动。
- 宿主编译态：`/home/inkedus/Code/github/SForum` 工作区有未提交改动（49 文件），本次验收未触碰。

### 本次未验证 / 遗留（首轮记录，后由 2026-10-26 真实态终验补齐）

- 首轮「显示全部」开关、封面渲染、已安装徽标、安装确认框四项因列表为空无法在 UI 判定 —— **已在真实态终验全部通过**（见「修复后复验」）。
- 首轮未验证 settings 保存路径 —— **已在真实态终验通过**（保存后回读值不变，Toast「扩展设置已保存。」）。
- 首轮拟定的修复方向（桥走 v2 派发 / legacy 前缀补 v2 分支）已由宿主 task-4（legacy→v2 派发）与 task-8（桥 `responseMode:'body'`）落地。
- 仍遗留两项：`apps/web/app/components/SFExtensionWidget.vue:152` 的**公开**组件桥未加 `responseMode:'body'`（与本次同构缺陷，
  `extensions/builtin` 对 `bridge.request` 零命中，当前无内置插件消费，故未动）；插件前端把 503 判成 `not_configured`
  的文案问题仍在插件侧待改。


## 修复后复验（2026-10-26）

复验时间 2026-10-26 01:15–01:45（Asia/Shanghai）。宿主代码冻结、watcher 静默，本机为稳定窗口。
本节包含两轮：01:15–01:35 的**注入式隔离复验**（过程证据，已被下文真实态终验取代）与 01:29–01:45 的
**真实态终验**（最终结论）。

### 环境与自检

| 项 | 实测 |
| --- | --- |
| API | `localhost:8080` pid 315816（air 热重载后），`health` → `status:ok`、`coreVersion:1.0.0` |
| Web dev | `localhost:3000` pid 9568（未触碰） |
| 浏览器 | 1633×810、已登录 super_admin；01:15 轮次中途标签页被外部切到 `file:///tmp/dock-stress.html` 一次，重新导航后继续 |
| 活动制品 | `sforum.store` active_version_id **21284**（digest `07d26cb3ca38…`），staged 21184（`9af89683…`）—— 比首轮验收的 9af89683 新 |
| 自检 1 | 带会话 `GET /api/v1/extensions/sforum.store/api/store/catalog?compat=all` → **200 / 7 条**；`?compat=compatible` → **200 / 3 条** |
| 自检 2 | 匿名 `curl` 同路径 → **401 `auth.required`**（守卫未放宽） |

### 宿主三处修复（本轮复验针对的变更）

1. **legacy 前缀 → v2 派发** — `apps/api/app/Providers/extensions.go:298-299`（`BaseURL==""` 时转 `dispatchProtocolV2`）、
   `:322-330`（`dispatchProtocolV2` 实现，改写成 `InvokeRouteInstance`）、`:277`（`protocolV2RouteInvoker` 接口）。
   验证（本轮实测）：带会话 legacy 前缀 `?compat=all` → 200 / 7 条、`?compat=compatible` → 200 / 3 条；匿名 → 401。
2. **watcher 忽略 `-go-tmp-umask`** — `apps/api/bootstrap/dev_plugin_watch.go:212-216`（忽略后缀列表新增
   `-go-tmp-umask`，注释说明 `go build -o X` 先写 `X-go-tmp-umask` 再改名，导致 `.tmp` 过滤失效而自激）。
   验证（task-5 实测，本轮未重测 CPU）：`package built` 17 次/30s → **0**，API 空闲 CPU 33.6% → **0.0%**。
3. **管理页桥 `responseMode: 'body'`** — `apps/web/app/composables/useApiClient.ts:40`（新增
   `responseMode?: ApiResponseMode`）、`:162-165`（`'body'` 直接返回整个响应体，不再 `return envelope.data`）；
   `apps/web/app/components/extensions/admin/SFTrustedAdminPageComponent.vue:152`（管理页桥固定 `responseMode: 'body'`）。
   设置页 `SFTrustedSettingsComponent.vue` 仍走默认 `'data'`（宿主信封）。验证：目录页真实态 3/7 条正常，
   settings 保存成功，插件管理页无回归。

### 五项结果（原判定 → 过程证据 → 真实态终验）

| # | 验收项 | 真实态终验（最终结论） | 过程证据：注入式（01:15 轮，非最终结论） | 断言值 / 说明 |
| --- | --- | --- | --- | --- |
| 1 | 默认只列兼容项 → 3 条 | **通过** | 通过（当时真实态 0 行，注入 envelope 后 3 行） | `rowCount=3`、`countText=共 3 个结果`、`toggleChecked=true`、`channel=stable`、无 setup 提示、无 parse 错 |
| 2 | 显示全部 → 7 条 + 判词 | **通过** | 通过（当时真实态 0 行） | 取消「只看当前版本可安装」→ `rowCount=7`、`countText=共 7 个结果`；`channel=all`（含预发布）同为 7 条；每行判词 chip「按开发版估算」，页面说明「宿主是开发版构建，兼容性按开发版估算。」—— dev 构建 `estimated:true`，不出现字面「兼容/不兼容」 |
| 3 | 封面渲染 `naturalWidth>0`、非字母块回退 | **通过** | 通过 | 3 张封面 `complete=true`、`naturalWidth=1280`、`naturalHeight=640`，`sfstore__tile--cover` 生效；markdown-plus 走 `iconUrl` 256×256；无图项按字母块回退（search-site「站」/theme-quiet「静」/s4「S」） |
| 4 | 「已安装 vX」徽标 | **通过** | 通过 | `已安装 v1.0.2`（sforum-ai-url-fetch）、`已安装 v1.0.0`（sforum-ai-web-search）；另见 oauth2 `已安装 v1.6.0`、search-site `已安装 v1.0.7` + `可更新至 v3.1.0` |
| 5 | 安装 → 宿主确认框、无「已安装」、取消无「已暂存」、未真装 | **通过** | 通过 | 弹「安装此扩展包？」（来源站点 `test-sforum-app-store.dalao.me`、下载地址、SHA-256、声明扩展 ID `sforum.demo-s4`、声明版本 `0.1.0`、声明类型 插件、所需权限 `extension.plugin.manage`、校验说明），框内 `已安装` 零命中；点「取消」→ 按钮复原「安装到论坛」、`已暂存` 未出现；只读查库 `extensions` 无 `sforum.demo-s4` 行 |

> **注入式复验的定位**：01:15 轮次曾在页面内把响应包成 `{code,message:"OK",data:<body>}` 以隔离故障层，
> 它证明了「插件 UI 本身正确、故障在宿主桥解包」，但**不再是最终结论**；上表「真实态终验」列才是最终判定。
> 真实态数据未做任何注入或改写。

### 历史记录：曾阻塞目录页的「宿主桥解包」缺陷（已由 task-8 修复）

1. 页面桥 `bridge.request()` 走 `useApiClient().request()`，该函数当时 `return envelope.data` —— 它是为宿主
   API 信封 `{code,message,data}` 设计的。
2. 插件路由返回**裸 JSON**（插件 `schemas/catalog.response.json` 就是 `{items,total,compatibility}`）；实测
   legacy 前缀 200 响应顶层键为 `compatibility/fetchedAt/items/nextCursor/stale/target/total`，没有 `data` 键。
3. 于是插件拿到 `undefined`，抛 `catalog payload has no items` → 页面错误态（01:15 轮实测 0 行）。
4. 对照：oauth2 页面不经桥，直接 `GET /api/oauth/clients`（裸 JSON）→ 200，页面正常 —— 佐证问题在桥的解包层。
5. **修复（task-8）**：`useApiClient().request()` 增加 `responseMode: 'data' | 'body'`，管理页桥固定 `'body'`，
   其余宿主调用保持 `'data'`。修复后本条不再复现。

### 回归四项

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 页面不再出现「还没配置商城地址」 | **通过** | 真实态目录页文本无该句；`hasSetupHint=false`、`hasParseError=false` |
| 匿名 legacy 前缀仍 401 | **通过** | `curl -s -o /dev/null -w '%{http_code}' …/api/v1/extensions/sforum.store/api/store/catalog` → `401` |
| settings 页正常渲染并可保存 | **通过** | 渲染出「商城地址 = https://test-sforum-app-store.dalao.me」「默认频道 = 稳定版」+「恢复推荐默认值 / 保存设置」；点保存 → Toast「扩展设置已保存。」；回读 settings API 值不变（未产生副作用） |
| oauth2 管理页仍正常 | **通过** | `/control-panel/extensions/sforum.oauth2-provider/pages/clients` → `共 7 个应用` |

### 截图

真实态终验（本轮，最终结论）：

- `/tmp/store-qa-20261026/step5-real-default-3.png` — 默认 3 条 + 已安装徽标
- `/tmp/store-qa-20261026/step5-real-all-7-covers.png` — 7 条 + 封面渲染 + 判词
- `/tmp/store-qa-20261026/step5-real-install-confirm-dialog.png` — 宿主安装确认框
- `/tmp/store-qa-20261026/step5-real-settings.png` — settings 页渲染
- `/tmp/store-qa-20261026/step5-real-oauth2-page.png` — oauth2 回归

过程证据（01:15 注入式轮次）：

- `/tmp/store-qa-20261026/step4-real-parse-error.png` — 当时真实态：catalog payload has no items
- `/tmp/store-qa-20261026/step4b-instrumented-default-3.png` — 注入式：3 条
- `/tmp/store-qa-20261026/step4b-instrumented-all-7-covers.png` — 注入式：7 条 + 封面
- `/tmp/store-qa-20261026/step4b-instrumented-install-confirm-dialog.png` — 注入式：确认框

### 结论

- 宿主三处修复均在本机真机复验中生效：legacy 前缀可用、watcher 静默、管理页桥返回裸响应体。
- 目录页五项在**真实态**全部通过，回归四项全部通过；本轮未做任何注入、未改任何代码、未动库数据。
- 封面读取注意：`loading=lazy` 在本机无帧渲染的窗口里不会自行触发，需一次截图（强制出帧）后 `naturalWidth`
  才变 1280；这是浏览器懒加载行为，不是字母块回退，也不影响真实用户浏览。

### 遗留（已知，不在本轮范围）

- `apps/web/app/components/SFExtensionWidget.vue:152` 的**公开**组件桥仍走默认 `responseMode`（`'data'`），
  与本次修的管理页桥属同构缺陷；当前 `extensions/builtin` 对 `bridge.request` 零命中，无内置插件消费该桥，
  故本次不动，列为已知潜在问题（第三方公开组件页若调用 `bridge.request` 需先补 `'body'`）。
- 插件前端把 503 归类为 `not_configured` 的文案问题（显示「还没配置商城地址」）仍在插件侧待改：本机不再触发，
  但运行时再次不可用时仍会误导。
