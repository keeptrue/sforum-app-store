# 插件菜单分组、宿主版本转发与已装清单

Status: accepted
Date: 2026-10-25
Related: SForum `2026-10-25-core-version-surface.md` §5、本仓 `2026-10-24-s5-plugin-admin-page.md`

## 背景

S5 落地时插件只有一个 component 管理页，设置文档（`manifest/settings.json`）没有任何菜单页
承载，结果**管理员在后台改不了商城地址**：扩展列表的「管理」按 `admin.entry` 落到
`/catalog`（component 页），而设置只在 `view=settings` 的页面上由宿主渲染。

同一时间 SForum 侧补齐了两条我们当时判定「不存在」的面：

1. v2 握手带 `host_build`，插件可由 `Server.HostBuild()` 读到 `coreVersion` / `buildVersion`；
   决策 §5 的两条重开条件（宿主发版含该面 + 插件 `go.mod` 指向的 SDK 带字段）都满足。
2. 宿主 Query `sforum.core.extensions.inventory.list` 提供去敏感清单（id/version/type/status），
   能力 `extensions.read`（中等风险）可授予第三方插件。

同时商城的 `/api/v1/catalog` 早已支持 `sforum` / `sforumBuild` / `compat` / `kind` 与
`socialImageUrl`，插件一个都没消费。

## 决定

### 1. 设置页走宿主 Schema UI，不写第二个自绘组件

`admin.pages` 增加 `{path: "/settings", view: "settings", menu: true, group: "应用商城",
permission: "extension.plugin.manage"}`。保存、重置、脱敏、审计继续归宿主。

- 理由：字段只有两个，自绘组件要自带保存/校验/CSRF/错误映射，收益只是「测试连接」这类按钮；
  而宿主已经保证保存路径的一致性（`canManageExtensionSettings`）。
- 代价：想加「测试商城连通性」这类交互时，只能改成 `view=component`（重开条件）。

### 2. 菜单用 `group` 收成一级，不改 core

两个 menu 页同 `group: "应用商城"`，容器与图标由宿主按 `order` 最小页生成。`admin.entry`
保持 `/catalog`，保证扩展列表的「管理」仍落到商城页。组内顺序：商城（30）→ 设置（40）。

### 3. 版本只来自握手快照，`compat` 由页面开关决定

- 后端从 `Server.HostBuild()` 取一次（进程内冻结），作为 `sforum` / `sforumBuild` 转发；
  调用方带来的同名查询参数一律丢弃。宿主没给 → 不发送、目录保持 `unknown`。
- `/api/store/catalog` 接受 `compat=compatible|all`（默认 `compatible`），非法值 400。
  页面开关只在页级结论不为 `unknown` 时出现：过滤不生效时不给假开关。
- 不引入第二种版本来源（不读 health、不读 page-bootstrap），避免两条语义不同的版本面。

### 4. 已装清单读宿主 Query，失败静默降级

- 新增能力 `extensions.read`；`sforum.core.extensions.inventory.list` 分页读到 100×10 条，
  按扩展 id 对齐目录条目，输出 `installed: {version,status} | null` 与
  `updateAvailable: boolean`（Masterminds semver 两端都能解析才比较）。
- 整次读取共用 2 秒预算；结果（含失败）缓存 60 秒，避免能力未授予时每个请求都等满超时。
- 「已安装 / 可更新」是**宿主清单事实**，与安装流程的「已暂存」语义分开：后者仍然不许写
  「已安装」。

### 5. 品牌分享卡直接进目录卡片

`ProductSummary.socialImageUrl` 已存在，插件此前丢弃。现在作为卡片/详情封面（96×48 / 128×64，
2:1 裁切），失败逐级回退 `iconUrl` → 字母块；两个地址都只放行 http(s)。浏览器直连商城取图，
不做图片代理（与既有「商城不进论坛请求链路」一致）。

## 代价与已知限制

- 能力清单多一条中等风险项，启用审查时多一行披露。
- 开启转发后目录默认**真的变短**：本机 dev 宿主 `coreVersion=1.0.0`，公开商城 8 个产品里只有
  3 个满足约束。这是判词的正常结果，页面文案已写明「已按宿主版本筛出」。
- 旧宿主 / 未授予能力时没有已装徽标；没有版本时不显示兼容开关。
- `installed` 与目录缓存是两个 TTL（各 60 秒），刚装上某个扩展时徽标最多延迟一分钟。

## 重开条件

- 需要「在目录里一键升级」：仍必须走宿主页面级安装动作（`bridge.installExtension`），
  插件不得自行安装/启用；届时只需把 `updateAvailable` 接到安装按钮。
- 需要跨节点共享目录缓存：改用共享缓存（当前是进程内 ETag 缓存）。
- 需要 390px 的管理页证据：本机镜像浏览器绘制面固定在 ~500px，只能换真机或换截图通道。
