# 2026-10-27 扩展更新徽章 T5 验收（商城仓）

本文件是「扩展管理三页显示商城更高版本徽章」的最终验收记录（商城侧）。
Core 侧同名文件：`SForum/knowledge/sessions/2026-10-27-extension-update-badges-review.md`。
两份内容共享同一批观测，仓库差异各自分节。

最终运行态：`sforum.store` enabled / active version `22851` / `0.1.1` / package_digest `6bf70405…` / staged 空；
插件 backend digest `9f07867b…`、admin mjs `557a9dd0…`、props `39aec253…`、result `e740a0a4…`、
css `68026203…`（18,101 B）；三条 `list_column` contractVersion `@2`、placement `@1`、permission `extension.view`、priority 10。

## Changed

### 商城服务端（`service/`）

- `service/src/lib/catalog/query.ts`（+24）/ `query.test.ts`（+137）
  目录查询支持 `extensionIds`：按逗号分隔、去重、排序，与 `compat=all`、`platform=all` 组合。
- `service/src/lib/catalog/extension-ids.ts`（新增，44 行）：`extensionIds` 的解析与上限约束。
- `contracts/store-api.yaml`（+12）、`service/src/lib/api-types.ts`（+10）：契约与类型同步。

### 商城插件（`plugin/plugins/sforum.store/`）

- `backend/surfaces.go`（新增，458 行）：三条 `list_column` 声明（plugins/themes/overview）+
  统一 handler `sforum.store.admin.updates`。`InvokeHook` 覆写 SDK 默认分发，先调 `Health`
  校验运行时身份，再按 `hookId` + `contractVersion` + props schema 精确匹配；跳过 builtin、
  取 `max(active, staged)`、100 个一组、只比 semver（`mapping.go updateAvailable`）。
- `backend/upstream.go`（+24）：目录请求带 `extensionIds`，`compat=all&platform=all`。
- `backend/surfaces_test.go`（新增）：分块、去重、失败语义、locale 文案等覆盖。
- `manifest/admin-surfaces.json`（新增，47 行）、`schemas/admin-updates.props.json`、
  `schemas/admin-updates.result.json`：精确制品声明与 props/result schema。
- `sforum.extension.json`（+26）：注册 surface 与组件。
- `frontend/admin/src/deep-link.ts`（新增，20 行）+ `deep-link.test.ts`：商城详情页深链解析。
- `frontend/admin/src/catalog.ts`（+44）、`frontend/admin/dist/catalog.mjs`：详情页按 `?product=` 打开。
- 决策：`knowledge/decisions/2026-10-27-update-badges-via-admin-surface.md`。

## 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `bun run typecheck` | exit 0 |
| `bun run test` | **826 pass / 0 fail**（service） |
| `cd plugin/plugins/sforum.store/backend && go vet ./...` | exit 0 |
| `cd plugin/plugins/sforum.store/backend && go test ./... -count=1` | ok，0.738s |
| `bun test plugin/plugins/sforum.store/frontend/admin/src` | **185 pass / 0 fail** |
| `bun run manifest:check` | exit 0 |

Core 侧（供对照）：`bun test` 1767 pass / 0 fail、`bun run typecheck` exit 0、
`go build ./...` exit 0、architecture boundaries 通过（1963 文件）、`v3-catalog --check` 通过（18 文件）。

## 浏览器 QA 证据

三类证据严格分开：**真实商城数据**、**fixture 注入**、**浏览器层响应注入**。
fixture 注入不是真实插件数据；浏览器层注入既不是 fixture 也不是真实数据。

环境：共享浏览器窗口 1657×922（视口 1633×810）；390×844 用隔离无头 Chrome
（`Emulation.setDeviceMetricsOverride`，dpr 3）。截图：`/tmp/sforum-qa/shots`（易失）与持久副本 `~/下载/sforum-qa/`。

### A. 真实商城数据

- 三页 @1633×810：0 徽章、0 warning、`button[aria-label="检查更新"]` 存在、`scrollWidth=1633`（无横向溢出）。
  截图 `A1-plugins-real-empty-1633x810.png`、`A2-themes-real-empty-1633x810.png`、`A3-overview-real-empty-1633x810.png`。
- 真实数据徽章旁证（04:34，真实基址，经本仓 owner 用 `audit_events` 核对）：
  直接 invoke 返回 `cells {sforum.oauth2-provider: "可更新至 v1.7.0"}`；总览页徽章真实挂上，
  点击进入 `/control-panel/extensions/sforum.store/pages/catalog?product=oauth2-provider`，
  `.sfstore__overlay` 打开，弹层含「已安装 v1.6.0 / 可更新至 v1.7.0」。
  截图 `03-overview-real-badge-1633x810.png`、`04-overview-badge-click-catalog-overlay-1633x810.png`。
  同时刻远端 `latestVersion=1.7.0`；04:41 起改为 `1.6.0`（== 已装）→ 真实路径回到空结果。
- **05:06 之后远端对该批量查询返回 502**（`curl` 复现 `HTTP 502 in 1.78s`，单 extensionId 同样 502），
  因此最终状态下真实路径是 warning 而非空结果。属上游状态，不是本功能回归，也未定位原因。

### B. fixture 注入（本轮由 reviewer 重建）

`/tmp/sforum-qa` 在 05:0x 被外部清空（原 fixture 与截图丢失），因此重建了等价 fixture：
自签 CA（SAN `IP:127.0.0.1`）装入系统信任 + Node HTTPS 服务监听 `127.0.0.1:8443`，
基址前缀 `/update` 用于隔离插件缓存键；设置经
`PUT /api/v1/admin/extensions/sforum.store/settings` 切换、`POST …/restart` 立即生效。

- 三页徽章：plugins → `可更新至 v1.7.0` → `?product=oauth2-provider`；
  themes → `可更新至 v1.1.0` → `?product=theme-quiet`；overview → 两条都在。
  全部 `inButton:false`、`nested:0`、`visible:true`。
  截图 `B1-overview-fixture-update-1633x810.png`、`B3-plugins-fixture-update-1633x810.png`、`B4-themes-fixture-update-1633x810.png`。
- 徽章归属：主题页两行同名「SForum 默认主题」，徽章挂在 `acme.switchtest · v1.0.0` 行，
  `sforum.default-theme` 行 `hasBadge:false`（builtin 按设计跳过）。
- 点击插件页徽章：落地 `?product=oauth2-provider`，`.sfstore__overlay` 存在
  （`class="sfstore__overlay sfstore-dialog"`），弹层含「已安装 v1.6.0 / 可更新至 v1.7.0」。
  截图 `B2-overview-badge-click-catalog-overlay-1633x810.png`。
- 总览页徽章点击不改变选中态：`rowButtonClicked=0`、`aria-pressed` `false → false`、URL 不变，
  默认选中行保持 `true`。
- fixture 503：三页 warning「扩展更新检查未完成。」+「可更新: 管理端界面扩展运行时暂时不可用，请稍后重试。」+「重试」，
  「检查更新」保留，徽章 0。截图 `D1…/D2…/D3-plugins|themes|overview-fixture-503-warning-1633x810.png`。
- 未配置基址：三条 surface 200 且 `cells {}`/`links {}`（无上游调用），页面无徽章无 warning 按钮保留。
- 真实传输失败 `https://127.0.0.1:9`：503 → warning + 重试。截图 `E1-overview-502-transport-warning-1633x810.png`。
- 插件停用：surface 归零（`/admin/admin-surfaces` 返回 0），三页 0 徽章 0 warning，
  「检查更新」按钮消失。截图 `F1-plugins-store-disabled-1633x810.png`。
  再启用后回到 enabled / active 22851 / `0.1.1` / staged 空，三条 surface 全部回来。

### C. 浏览器层响应注入（非法 links / 无 link）

- `links = {"sforum.oauth2-provider": "//evil.example.test/x"}`：
  `labelNodes=[{tag:"SPAN", inAnchor:false, title:"可更新"}]`、`productAnchors=[]`、`evilAnchors=0`。
  截图 `C1-plugins-illegal-link-badge-span-1633x810.png`。
- `links = {}`：同上，徽章为 `SPAN`、`inAnchor:false`、无 `?product=` 链接。

说明：`links` 不是上游字段，而是插件按 `updateSurfaceLink(slug)` 本地拼的（slug 先过
`slugPattern`），因此非法深链只能在浏览器层改写响应来验证，fixture 加模式反而验不到真链路。

### D. 只读临时用户

- 只带 `extension.view` → 被重定向到 `/`（Core 的 admin 中间件要求 `admin.access`）。
  截图 `I1-deny-extension-view-only-redirect.png`。**任务书前提不成立**，最小只读组合是
  `admin.access` + `extension.view`。
- `admin.access` + `extension.view`：三页可打开，徽章 1 / 1 / 2 条，0 warning，「检查更新」存在。
  截图 `G-plugins-readonly-1633x810.png`、`G-themes-readonly-1633x810.png`、`G-overview-readonly-1633x810.png`。
- 后端只读权威：该用户 cookie 调 `POST …/sforum.store/disable` 与 `POST …/upgrade` 均
  `403 {"reason":"permission.denied"}`，插件仍 enabled。
- UI 仍渲染可点管理动作：plugins 64 个中 53 个 `disabled=false`，overview 61 个中 53 个。
- 清理：三只临时账号 user id 427 / 428（只读用例）、429（仅 `extension.view` 的拒绝用例）均
  「撤销会话 → 清空角色 → `status=banned`」，临时角色 `qa-extension-viewer`、`qa-extension-view-only` 已删除。
  产品无 DELETE 用户路由，故未做 DB 硬删。回读 user 428 / 429：`status=banned`、`roleKeys=[]`、
  `permissions=[]`、活跃会话 0。

### E. 390×844

| 页面 | scrollWidth | overflowX | clipped 控件 | 徽章 | 徽章尺寸/可见 | 检查更新 | warning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| plugins | 390 | false | 0 | 1 | 119×24，在视口内 | 有 | 0 |
| themes | 390 | false | 0 | 1 | 118×24，在视口内 | 有 | 0 |
| overview | 390 | false | 0 | 2 | 119×24 / 118×24，均在视口内 | 有 | 0 |

截图 `H2-390x844-plugins-fixture-update.png`、`H2-390x844-themes-fixture-update.png`、`H2-390x844-overview-fixture-update.png`。

## Findings

### P1

无。三条 surface 的 `@2` 契约、props `39aec253…` / result `e740a0a4…` digest 与直接 invoke 200 均可复核；
「有更新 / 空 / 503 / 传输失败 / 未配置 / 停用」六种状态行为与设计一致。

### P2

1. **只读管理员看到可点的管理动作 —— pre-existing，非本功能引入（out of scope，Core 侧后续排期）**。
   Core 侧 `plugins.vue`/`themes.vue`/`index.vue` 的行操作区从未按 `extension.plugin.manage` 门控，
   `can('extension.plugin.manage')` 只用于内置自动更新开关与加载失败提示（HEAD 行 114/129/133/411）。
   git 证据：`git show HEAD:apps/web/app/pages/admin/extensions/plugins.vue` 的六条 `:disabled` 绑定
   （`upgradeAllBusy || !canUpgradePlugin(item)`、`item.status !== 'enabled'`、
   `!isExtensionArtifactAvailable(item)` ×2、`!canRestartPlugin(item)`、
   `item.status === 'enabled' && !isLifecycleV2Plugin(item)`）与工作区逐字相同，仅行号平移
   （HEAD 585/601/621/630/652/665 → 工作区 620/636/656/665/687/700），本功能没有改动这一层。
   观测值：只读用户（`admin.access` + `extension.view`）在 plugins 页 64 个管理按钮中 53 个
   `disabled=false`、overview 页 61 个中 53 个；点击后后端 403 `permission.denied`。商城侧无需改动。
2. **失败信息不可区分**：503（插件运行时不可用）、504（surface 5s 超时）、502（上游传输失败）
   在页面上文本完全一致，无法区分是商城的问题还是插件运行时的问题。
3. **插件重启后出站连接僵死会让同一批缓存键连续超时**：同一 themes 键连续 3 次 504
   （5014 / 5123 / 5018 ms），`POST …/restart` 后三条立刻 200（1791 / 614 / 594 ms）。
   「重试」不保证恢复，显式 restart 才可靠。

### P3

1. **目录请求失败被静默**：Core 侧把 `id === 'catalog'` 的失败过滤掉，且「检查更新」按钮依赖
   surface 非空，导致目录接口失败时页面既无 warning 也无按钮，与「没有 surface」不可区分。
2. **同名主题的徽章读屏不可区分**：`aria-label` 用显示名拼装，两个「SForum 默认主题」完全相同。
3. **未配置商城地址无提示**（已批准取舍，本次复核一致）。

## 未验证项

- `oldstore400`（400 → 静默空结果）与 `slow`（6s → surface 超时）模式：本轮 fixture 只实现 update 模式，
  这两种语义仅由 `surfaces_test.go` 单测覆盖，未在浏览器层复验。
- 401/403/404（不可重试）与 429（可重试）分支：同上。
- 插件升级路径（staged → 激活）：为避免改变 active 版本未执行。
- 商城详情页自身的 390 布局：不属于本功能范围。
- 真实商城 502 的根因：未定位（`curl` 可稳定复现，非本仓代码路径）。

## 残余风险

- `plugin/plugins/sforum.store/frontend/admin/src/catalog.ts` 1051 行（HEAD 1021），后续应抽详情选择/平台匹配。
- dev 环境出站代理（`127.0.0.1:7897`）连接复用会在插件重启后僵死，可能连续多次 5s 超时。
- 商城未配置时无提示（已批准取舍）。
- 旧商城 400 静默空结果 vs 401/403/404 warning：只能靠页面级提示区分。
- `admin-surfaces.md` 里 `core.admin.page.users` 的 marker 漂移（identity 批次），out of scope。
- 真实商城 05:06 起对批量目录查询返回 502，恢复前「真实空结果」不可复现。

## 环境还原（最终状态）

- `sforum.store.catalog_base_url = https://test-sforum-app-store.dalao.me`、channel `stable`（DB 直读）。
- `sforum.store`：status=`enabled` / active_version_id=`22851` / version `0.1.1` /
  package_digest `6bf70405…` / staged 空（`staged_version_id IS NULL`）。
- fixture 已停止（`127.0.0.1:8443` 无监听）；临时 CA 已从系统信任移除（`/etc/ssl/certs` 无 sforum 链接，
  bundle 回到 120 张，公网 TLS 复测正常）。
- 临时账号 427 / 428 / 429 已「撤销全部会话 + 清空角色 + `status=banned`」，临时角色
  `qa-extension-viewer`、`qa-extension-view-only` 已删除。未做 DB 硬删：产品没有 DELETE 用户路由，
  且硬删会把 `audit_events.actor_user_id` 置 NULL，破坏本次 QA 的审计归属。
- 真实商城自 05:06 起为**整站 502**（`/`、`/api/v1/health`、catalog 三条均 `502 in ~1.4–1.6s`，
  返回边缘 `error code: 502` 页面）；05:15 Lead 复测仍 502，batch 与单 extensionId 都 502。
  属上游状态，非本功能回归。

## 证据位置说明

`/tmp` 本轮被外部清空两次，截图同时保存在 `~/下载/sforum-qa/`；`/tmp/sforum-qa/shots` 为易失副本。
fixture 与截图均不在仓库内，两仓零污染。
