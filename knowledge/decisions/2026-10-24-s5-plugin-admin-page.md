# 插件管理页：手写 ESM + 后端代理，不做跨域直连

Status: accepted
Date: 2026-10-24

## 背景

S5 要交付 `sforum.store` 插件：在论坛后台浏览商城目录、看详情、把选中的包装进论坛。
SForum 提供了两条可选的页面路线（`docs/extensions/trusted-admin-components.md`）：
Schema UI（无代码）与**预构建 Admin Micro-frontend**（`@sforum/admin-sdk@1` +
`@sforum/plugin-ui@1` + Vue SFC，由插件自带 Vite 构建）。同时，商城是**另一个源**，插件后端与
管理页、论坛与商城之间的网络关系需要先定。

## 决定

### 1. 管理页是手写的预构建 ESM，不引入 Vue/SDK 工具链

- 页面产出一个 `frontend/admin/dist/catalog.mjs`（`{apiVersion:1, mount(target, bridge)}`）+ 一个
  CSS，由 `bun build` 从 TypeScript 打包；不引入 Vite、不装 `@sforum/admin-sdk`、不把 Vue 打进包。
- 先例：SForum 官方的 `sforum-oauth2-provider` 管理页就是无构建步骤的纯 ESM；同一宿主、
  同一 ABI，行为已被验证。
- 代价：拿不到 Host 图标运行时（`bridge.icons` / `SPluginIcon`），按钮一律用文字；没有 Vue
  组件生态，页面用原生 DOM 渲染。
- 重开条件：页面复杂度超过「目录 + 详情 + 安装」三个视图，或需要 Host 的表单/表格组件时，
  再评估 SDK 路线；届时引入 Vite 与 npm 依赖，需要新的决策记录。

### 2. 页面只调用插件自己的后端，不跨域直连商城

- 管理页与论坛同源；商城是另一个源。浏览器直连商城需要商城开 CORS（放宽来源白名单），
  而商城目前是「匿名可读、按 IP 限流」的公开 API，没有为论坛后台开放 CORS 的计划。
- 因此三条 `bridge.request` 路由都落在插件后端：`/api/store/catalog`、`/api/store/product`、
  `/api/store/install-url`。页面拿不到商城地址，也不知道上游存在。
- 后端只访问配置的 `catalogBaseUrl`（https），请求体里不接受 URL —— 插件没有通用抓取面。

### 3. 不向商城声明宿主版本

SForum 侧 D9 明确暂不暴露 `coreVersion`。插件因此**不发送** `sforum`/`sforumBuild` 参数：
商城目录按 `compatibility=unknown` 处理、不过滤，只展示每个版本的 `sforumVersion` 约束；
真正的兼容判定由 core 在安装时做（`incompatible` 是最终裁判）。这与「商城永远不是兼容性的
最终裁判」一致。

### 4. v1 不做「已装/更新检查」

「已装清单 vs 最新版本」需要宿主提供已装扩展的读取面（`extensions.read` 或等价查询），
落地契约里没有给页面用的一条稳定通道；S5 不做，目录页只展示可用版本。更新检查留 S6，
届时先看 SForum 是否开放只读清单。

### 5. 安装只在页面里发生，且只到暂存

按 SForum `2026-10-24-admin-page-host-action.md`：清单声明 `hostActions`，页面调
`bridge.installExtension`，宿主下载、校验摘要、比对清单身份、暂存。插件后端**不**安装、
不存包体、不 enable/trust。旧宿主没有该 bridge 成员时降级为「复制签名链接」。

### 6. 缓存放进程内，不用 Host PluginFiles

计划 §6.4 原写「缓存到 Host `PluginFiles`」。S5 改为**插件进程内的 ETag 缓存**：目录是只读
公开数据、单进程生命周期与插件进程一致、失效靠 ETag 而不是文件系统。放在 Host 里会多一层
序列化与权限面，收益只是跨重启，而重启时目录本来就该重读。
重开条件：多节点部署需要共享缓存，或目录体量大到单进程内存吃紧。

## 放弃的方案

- **Vue + `@sforum/admin-sdk`**：工具链更重、构建产物更大、要跟 npm 版本，而页面只有三个视图。
- **浏览器直连商城**：要给商城开 CORS 白名单，扩大公开面且与「论坛不直连商城」的故障域相悖。
- **声明 `extensions.install` 能力 + 命令/worker**：SForum 已否决（D3/D8），且能把安装变成无人
  值守动作。
- **把 `sforumVersion` 当版本号在页面上过滤**：语义错误（它是 Masterminds 约束），且商城已经
  按约束求值。

## 代价与重开条件

- 手写 DOM 意味着没有组件复用；页面状态要自己管。分页、筛选、详情三块已足够小。
- 进程内缓存随插件重启失效（可接受）；多节点不共享。
- 没有图标运行时，视觉上比其他管理页更素；这与「按钮用文字」的既有约定一致。
- 若 SForum 以后开放宿主版本或已装清单，第 3、4 条要重开（目录可做真正的兼容过滤与更新检查）。
