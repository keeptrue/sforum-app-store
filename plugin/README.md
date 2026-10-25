# plugin

SForum 扩展 `sforum.store`：商城在论坛后台的入口。仓库根的 `plugin/` 是 SForum 的
`EXTERNAL_EXTENSION_ROOTS` 源根，扩展包本体在 `plugins/sforum.store/`。

## 宿主要求

页面内安装依赖 SForum 的**页面级宿主动作**（`hostActions: ["extension.install"]` +
`bridge.installExtension`），落地于 SForum `10c2b21e8`（2026-10-24）。更旧的宿主会拒绝含
`hostActions` 的清单（`additionalProperties: false`）。管理页仍会特性检测：宿主没有该 bridge
成员时降级为「复制签名链接」，不会假装能装。

## 结构

```text
plugins/sforum.store/
  sforum.extension.json   # Manifest V3：3 条路由 + 1 个 component 管理页 + packageFiles 摘要
  backend/                # Go 插件进程（SDK: sforum/apps/api/sdk/plugin/v2）
    main.go               # pluginv2.Serve
    routes.go             # InvokeRoute 分发 + 响应信封（schema 绑定）
    handlers.go           # /api/store/{catalog,product,install-url}
    upstream.go           # 商城 HTTP 客户端 + ETag/TTL 缓存
    settings.go           # 通过 Host own-settings 查询读 catalogBaseUrl / channel
    cmd/validate-manifest # 用 SForum 自己的加载器与校验器离线检查清单
  frontend/admin/src/     # 手写 ESM 源码（TS）+ CSS，构建时打包到 dist
  frontend/admin/dist/    # 包内产物（catalog.mjs / catalog.css）
  manifest/               # langs + settings 文档（Schema UI）
  schemas/                # 路由请求/响应 JSON Schema（id@1）
  openapi/routes.yaml     # 三条路由的契约描述
```

构建脚本在**包外**：`plugin/scripts/build.sh`（Go 构建 → 管理页打包 → 摘要 → 清单校验）、
`plugin/scripts/sync-digests.mjs`（重算 `packageFiles` / `backend.digest` / `openapi.digest`）。
这样发布 ZIP 里不会带构建脚本。

## 命令

```bash
# 完整构建 + 清单校验（需要 SForum 检出于 ../../../../../SForum，或先改 replace）
bash plugin/scripts/build.sh

# 只校验清单（改完 manifest/schemas 后）
cd plugin/plugins/sforum.store/backend && go run ./cmd/validate-manifest ..

# 后端测试
cd plugin/plugins/sforum.store/backend && go vet ./... && go test ./...

# 管理页测试与打包
bun test plugin/plugins/sforum.store/frontend/admin/src
bun build plugin/plugins/sforum.store/frontend/admin/src/catalog.ts \
  --target=browser --format=esm --outfile=plugin/plugins/sforum.store/frontend/admin/dist/catalog.mjs

# 用 SForum 自己的打包器产出发布 ZIP（校验 + 摘要 + SBOM）
cd ../SForum/apps/api && go run ./cmd/sforum extension package \
  /home/inkedus/Code/github/sforum-app-store/plugin/plugins/sforum.store \
  --exclude-source -o /tmp/sforum.store.zip
```

`backend/go.mod` 用 `replace` 指向同级 SForum 检出；CI 检出 SForum 后
`go mod edit -replace` 覆盖（见 `.github/workflows/ci.yml` 的 `plugin` job）。

## 安装交接（唯一允许的路径）

1. 管理页从插件后端拿 `{url, sha256, size, expiresAt}`（商城签名短链，30 分钟）。
2. 调 `bridge.installExtension({url, sha256, expectedExtensionId, expectedType, expectedVersion})`。
3. 宿主做权限预检、自己的确认框、同步安装并比对清单身份；成功语义是**已暂存**。
4. 启用与信任由管理员在 core 的扩展页面完成。插件不 enable、不 trust、不 upgrade，也不做
   后台静默安装。

## 不该做的事

- 不要在插件里存论坛 token 或任何用户凭据。
- 不要把商城目录写进扩展自己的库；缓存只在进程内。
- 不要声明 `extensions.install` 能力（该能力不存在于落地契约）；安装是页面动作。
- 不要用 emoji 或自绘 SVG 当图标；手写 ESM 没有 Host 图标运行时，按钮用文字。
