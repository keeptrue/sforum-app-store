# plugin

SForum 扩展 `sforum.store`：商城在论坛后台的入口。仓库根的 `plugin/` 是 SForum 的
`EXTERNAL_EXTENSION_ROOTS` 源根，扩展包本体在 `plugins/sforum.store/`。

## 宿主要求

| 能力 | 宿主面 | 缺失时 |
| --- | --- | --- |
| 页面内安装 | 页面级宿主动作 `hostActions: ["extension.install"]` + `bridge.installExtension`（SForum `10c2b21e8`） | 更旧的宿主拒绝含 `hostActions` 的清单；有清单但无 bridge 时按钮隐藏，降级为「复制签名链接」 |
| 安装并启用 | 同一页再加 `"extension.install.enable"` + `bridge.installAndEnableExtension`（宿主确认弹窗固定 `z-[80]`） | **清单级硬依赖**：不认识这个 id 的 core 会把整份清单判为非法（`validateAdminHostActions` → `ErrInvalidManifest`），页面不加载；没有「降级成只安装」这回事 |
| 菜单分组 | `admin.pages[].group` | 两个页平铺在「扩展管理」内，功能不变 |
| 宿主版本 | v2 握手 `host_build` → `Server.HostBuild()` | 目录 `compatibility=unknown`、不过滤、无兼容开关 |
| 已装清单 | `sforum.core.extensions.inventory.list`（能力 `extensions.read`） | 不显示「已安装 / 可更新」 |

### 发版清单（`extension.install.enable` 引入后）

- **`sforumVersion` 现在故意保持 `>=1.0.0`。** 动作 id `extension.install.enable` 还没发版：宿主 dev 的
  `CoreCompatibilityVersion()` 由最近的 git tag 派生（当前 `git describe` = `v3.0.16-14-g8ab9f246b-dirty`，
  派生出 `3.0.16+14.g8ab9f246b.dirty`；`+` 之后是构建元数据，**不参与约束比较**，所以语义上就是 3.0.16）。
  提前抬到 `>=3.0.17` 会让**现在这台 core 直接拒绝这份清单**，本地先炸。core 打出含该动作的下一个 tag
  之后，再把 `sforumVersion` 抬到那个版本。
- **CI 的 SForum pin 必须同时换，这是推送前的硬阻塞。** `.github/workflows/ci.yml` 的 `plugin` job 仍停在
  `ref: 10c2b21e8`，那个 commit 不认识 `extension.install.enable`，`validate-manifest` 必然失败。
  等宿主侧含该动作的 commit 落地后一起换（现在换不到 commit，所以先不动）。

### 已知工具缺陷（不阻塞，待办）

- `plugin/scripts/sync-digests.mjs` 的 `digests: N updated` 只统计 `packageFiles` 与 `openapi[]`；
  `backend.digest` 是无条件覆盖的，后端二进制变了也不会出现在这个计数里。别把「0 updated」当成「什么都没变」：
  提交前在**安静检出**里重跑一次 `build.sh`，并核对 `sha256(backend/plugin) == manifest.backend.digest`。

## 菜单

侧栏一级「应用商城」→「商城」（`/catalog`，component）+「设置」（`/settings`，Schema UI）。
设置页由宿主按 `manifest/settings.json` 渲染，`permission: extension.plugin.manage`。
`admin.entry` = `/catalog`。

## 结构

```text
plugins/sforum.store/
  sforum.extension.json   # Manifest V3：3 条路由 + 2 个管理页 + capabilities + packageFiles 摘要
  backend/                # Go 插件进程（SDK: sforum/apps/api/sdk/plugin/v2）
    main.go               # pluginv2.Serve
    routes.go             # InvokeRoute 分发 + 响应信封（schema 绑定）+ 缓存/注入点
    handlers.go           # /api/store/{catalog,product,install-url}
    upstream.go           # 商城 HTTP 客户端 + ETag/TTL 缓存 + 宿主版本转发
    inventory.go          # 宿主已装清单查询（extensions.read）+ 60s 缓存 + 降级
    settings.go           # 通过 Host own-settings 查询读 catalogBaseUrl / channel
    mapping.go            # 上游 DTO → 路由 DTO（socialImageUrl / installed / updateAvailable /
                          #   author / notesHtml / installedRelation）
    cmd/validate-manifest # 用 SForum 自己的加载器与校验器离线检查清单
  frontend/admin/src/     # 手写 ESM 源码（TS）+ CSS，构建时打包到 dist
  frontend/admin/dist/    # 包内产物（catalog.mjs / catalog.css）
  manifest/               # langs + settings 文档（Schema UI）
  schemas/                # 路由请求/响应 JSON Schema（id@1）
  openapi/routes.yaml     # 三条路由的契约描述
  brand/                  # icon.svg / icon.png / social-preview.png（不进 packageFiles）
```

构建脚本在**包外**：`plugin/scripts/build.sh`（Go 构建 → 管理页打包 → 摘要 → 清单校验）、
`plugin/scripts/sync-digests.mjs`（重算 `packageFiles` / `backend.digest` / `openapi.digest`）。
`src/` 是可读源码，`dist/` 是构建产物：`.mjs` 与 `.css` **都**经 `bun build --minify` 产出，
体积预算（计划 §7.5 第 17 条 20 KB）因此说的是产物而不是源码。改了 `src/` 一定要重跑
`build.sh`，否则 `dist/` 与清单摘要对不上。
这样发布 ZIP 里不会带构建脚本。`brand/` 由 SForum 仓的 `scripts/brand/` 生成
（`spec.json` 里的 external 条目），**不要手改**。

## 能力

| key | 用途 |
| --- | --- |
| `host.api` | v2 路由握手与 Host 通道 |
| `settings.own` | 读自己设置里的商城地址与频道 |
| `net.outbound` | 出站访问商城 HTTPS API |
| `extensions.read` | 读去敏的已装扩展清单（已装 / 可更新徽标） |

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

# 品牌资产闸门（在 SForum 检出里跑）
go run ./cmd/sforum extension brand check <包目录>
```

`backend/go.mod` 用 `replace` 指向同级 SForum 检出；CI 检出 SForum 后
`go mod edit -replace` 覆盖（见 `.github/workflows/ci.yml` 的 `plugin` job）。

## 展示字段（详解见 docs/plugin.md §6）

- `installed` / `updateAvailable` / 每个版本的 `installedRelation` 全部来自宿主已装清单；
  清单读不到时一律缺省，页面按「未安装」处理，绝不推断。
- `author` 由商城下发（论坛账号 + 绑定仓库的 GitHub 账号，两半独立）；GitHub 链接由本插件用
  过白名单的 `login` 重新拼成 `https://github.com/<login>`，不信上游整串 URL。
  论坛个人主页地址（`author.profileUrl`，`<issuer>/u/<username>`）由商城拼好，插件只做
  http(s) 校验：管理页拿不到论坛域名。
- `notes` 是 Release 原文，`notesHtml` 是商城渲染并消毒后的 HTML；页面优先注入后者，
  旧商城没有这个键时退回纯文本。

## 安装交接（唯一允许的路径）

1. 管理页从插件后端拿 `{url, sha256, size, expiresAt}`（商城签名短链，30 分钟）。
2. 交给宿主，两种方法按能力选择：
   - 宿主有 `bridge.installAndEnableExtension`（页面声明了 `"extension.install.enable"`）→ 用它，
     回执带 `outcome: "enabled" | "upgraded" | "staged"`；
   - 否则退回 `bridge.installExtension`，回执没有 `outcome`，语义仍是**已暂存**。
3. 两次调用都传同一个请求体：
   `{url, sha256, expectedExtensionId, expectedType, expectedVersion}`。宿主做权限预检、自己的确认框、
   同步安装并比对清单身份。
4. 启用与信任**永远是宿主自己的流程**：可执行后端的包照样要 super_admin 审阅影响并给一次性确认，
   非超管或主题包会停在 `staged`。插件不 enable、不 trust、不 upgrade、不判定 `outcome` 之外的任何事，
   也不做后台静默安装；页面只是把宿主回报的结果如实写成「已启用 / 已升级 / 已暂存」。
5. 层级也归宿主：插件的详情遮罩固定 `z-index: 40`，宿主确认弹窗在 `z-[80]`，插件**不得**在安装期间
   改自己的 z-index 去抢层级（曾经的写法会让恢复后的遮罩盖住仍开着的宿主弹窗，整页点不动）。

## 不该做的事

- 不要在插件里存论坛 token 或任何用户凭据。
- 不要把商城目录写进扩展自己的库；缓存只在进程内。
- 不要声明 `extensions.install` 能力（该能力不存在于落地契约）；安装是页面动作。
- 不要自己推断宿主版本：只认握手快照。
- 不要用 emoji 或自绘 SVG 当图标；手写 ESM 没有 Host 图标运行时，按钮用文字。
