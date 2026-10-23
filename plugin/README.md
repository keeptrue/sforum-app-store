# plugin

SForum 扩展 `sforum.store`。仓库根 `plugin/` 就是 SForum 的 `EXTERNAL_EXTENSION_ROOTS` 源根，
扩展包本体放在 `plugins/sforum.store/`（框架约定的集合布局）。**S0 之前只有约定。**

## 目标布局

```text
plugin/plugins/sforum.store/
  backend/              # Go module，require sforum/apps/api + 本地 replace
  frontend/admin/       # Vue 3 + Vite，预构建 dist（Admin Micro-frontend API v1）
  manifest/             # admin / settings / langs
  schemas/              # 命令与组件 schema
  openapi/              # 插件路由契约（版本化 id@N 引用）
  sforum.extension.json # Manifest V3
```

## 硬约束

- 清单 `id` 固定 `sforum.store`；`capabilities` 需含 `extensions.read` 与 `extensions.install`，
  `database.grants` 需含 `host_commands`。
- 管理页是**预构建** ESM/CSS：宿主不编译 SFC，也不执行包内 Vite 配置。改前端必须重新构建并刷新
  摘要。
- wire 层 schema 引用必须是版本化契约 `id@N`；包内路径会在分发时被拒。
- 每条路由都要声明 `responseSchema`；响应必须自带 `Content-Type: application/json`。
- 调宿主必须 actorless（清空 `RequestContext.Actor`），否则宿主拒绝。
- 安装只调 `sforum.extensions.install.{plugin|theme}@1`，只轮询状态到 `staged`；不 enable、
  不 trust、不 upgrade。
- 不做后台静默安装；必须人类管理员当场触发。

## 开发方式

与 `sforum-oauth2-provider` 一致：两个仓库同级，`backend/go.mod` 用 `replace` 指向 SForum 检出；
CI 用 `go mod edit -replace` 覆盖。改了包内容（含 `.mjs`/`.css`/`schemas`）必须重新生成摘要，
宿主按 exact-artifact 校验。

## 不该做的事

- 不在插件里存论坛 token 或任何用户凭据。
- 不把商城目录写入扩展自己的库（用 Host `PluginFiles` 私有缓存）。
- 不用 emoji 或自绘 SVG 当图标；按钮用文字。
