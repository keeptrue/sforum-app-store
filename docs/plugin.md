# 商城插件 `sforum.store`

插件把商城目录搬进论坛后台，并把选中的包交给**宿主**安装。它不启用、不信任、不升级任何扩展，
也不保存论坛 token 或包体。

## 1. 宿主要求

| 能力 | 宿主面 | 缺失时的表现 |
| --- | --- | --- |
| 页面内安装 | 页面级宿主动作 `hostActions: ["extension.install"]` + `bridge.installExtension`（SForum `10c2b21e8`，2026-10-24） | 清单被拒（更旧的宿主）或安装按钮隐藏、只给可复制的签名链接 |
| 安装并启用 | 同一页再声明 `"extension.install.enable"` + `bridge.installAndEnableExtension` | **清单级硬依赖**：不认识这个动作 id 的 core 把整份清单判为非法（`validateAdminHostActions` → `ErrInvalidManifest`），页面根本不加载 |
| 菜单分组 | 清单 `admin.pages[].group`（同一扩展的多个 menu 页收进一个可展开一级菜单） | 两个页平铺在「扩展管理」里，功能不受影响 |
| 宿主版本 | v2 握手 `host_build` → 插件 `Server.HostBuild()` | 目录恒为 `compatibility=unknown`、不过滤、不显示「兼容」判词 |
| 已装清单 | Query `sforum.core.extensions.inventory.list`（能力 `extensions.read`，中等风险） | 不显示「已安装 / 可更新」，其余功能不受影响 |
| 写入自身 secret | `SecretService.Put/Clear`（host API v2，能力 `settings.own`） | 商城要求登录时连接流程失败并提示 `secret_write_failed`；匿名模式不受影响 |

前三条是**特性检测 + 降级**：旧宿主只会少功能，不会把页面打崩。

`extension.install.enable` 是例外，它是**清单级硬依赖**：宿主校验清单时，未知的动作 id 会让整份
`sforum.extension.json` 变成非法（`ErrInvalidManifest`），不是「悄悄降级成只安装」——页面在那种 core 上
压根不会加载。所以本扩展需要带这个动作的 core；页面里的 `installAndEnableExtension` 特性检测只用于
「core 认得动作但没注入方法」这种半新状态，不是旧宿主兼容层。

## 2. 菜单与页面

侧栏一级「应用商城」（可展开），两个子项：

| 子项 | 路径 | 形态 |
| --- | --- | --- |
| 商城 | `/catalog` | 预构建 Admin Micro-frontend（`view=component`） |
| 设置 | `/settings` | 宿主 Schema UI（`view=settings`），字段来自 `manifest/settings.json` |

一级分组由清单的 `group: "应用商城"` 声明，容器归宿主；组图标取组内 `order` 最小那一页的
图标。**两个页面都声明 `permission: "extension.plugin.manage"`**，七条路由也统一用
`access: "permission"` + `core.guard.permission`：能进安装页 = 持有插件管理权限。
这是 0.2 起的行为变化——`extension.view` 用户不再看到安装页，也调不到 `/api/store/*`
（安装会签发下载链接，那是有副作用的动作，不该只读角色能做）。

`admin.entry` 是 `/catalog`，扩展列表里的「管理」按钮直达商城页。

## 3. 安装

**方式 A：从包安装（推荐）**

1. 取到发布 ZIP 与它的 sha256（构建产物由 `plugin/scripts/build.sh` + SForum 的
   `extension package` 产出，摘要随包发布）。
2. 论坛后台 → 扩展 → 安装：粘贴 ZIP 的公网 HTTPS 地址与 sha256，提交。
3. 管理员在 core 完成信任（可执行后端）与启用。

**方式 B：从目录装配（开发）**

```bash
# SForum 检出里
APP_ENV=development EXTERNAL_EXTENSION_ROOTS=/path/to/sforum-app-store/plugin \
  go run ./cmd/sforum serve     # 具体启动命令以 SForum 文档为准
```

开发装配只用于本地；生产用方式 A。**源根只在 API 启动时读取**，改完 `.env` 要重启 API。

## 4. 设置

论坛后台 → 应用商城 → 设置（Schema UI，两个字段）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `sforum.store.catalog_base_url` | `https://app-store.dalao.me` | 商城基址（https）。新装或从未保存过设置时用这个默认值；**清空并保存后管理页只显示配置提示，不发任何请求** |
| `sforum.store.channel` | `stable` | 目录默认频道；`stable` 只列稳定版，`beta` 含预发布 |
| `sforum.store.account_token` | 空 | **由插件写入的 secret**（`type: secret`）。内容是商城授权后的账号凭据；设置页只显示「已配置」，不回显。手动填写只用于迁移，断开连接请用页面上的按钮 |

设置值由插件后端通过宿主的 own-settings 查询读取，缓存在进程内 60 秒；管理员改完设置后
最迟一分钟生效（重开管理页即可）。

### 4.1 连接商城（下载登录要求）

商城把签发下载链接改成「需要账号」之后（见 `docs/deployment.md` §7.5），插件页顶部会出现连接条：

| 状态 | 连接条 | 安装按钮 |
| --- | --- | --- |
| 商城匿名（默认） | 不显示 | 正常 |
| 需要登录、未连接 | 「商城要求登录后才能安装扩展」+「连接商城」 | 禁用，文案「登录后安装」 |
| 等待授权 | 「已在新标签打开商城授权页…（短码 XXXXXXXX）」+「取消」 | 禁用，文案「等待商城授权…」 |
| 已连接 | 「已连接为 @x。令牌有效至 …」+「断开连接」 | 正常 |

点「连接商城」之后：

1. 页面**同步**开一个 `about:blank` 新标签（`opener` 置空），再向后端要授权地址；
2. 后端生成 PKCE verifier（只留在进程内存）、向商城要一个请求 id，返回授权页 URL；
   页面校验 URL 与配置的商城地址同源后导航那个标签；
3. 管理员在商城 `/connect/{id}` 上看到商城账号、来源论坛、插件上报的名字与**短码**，
   确认短码和插件页上的一致后再批准；
4. 页面每 2 秒轮询一次，批准后后端用 verifier 兑换令牌，写进宿主的加密 secret 设置；
5. 页面显示「已连接为 @x」，安装按钮恢复。

令牌 30 天有效；「断开连接」会尽力撤销上游令牌并清空宿主 secret。令牌过期、被撤销或账号停用时，
下一次安装会收到 401，插件会清掉本地凭据并把页面翻回「连接商城」。

**旧商城**（没有 `/api/v1/auth/mode`）会得到 `mode: unsupported`，连接条不显示、安装照旧匿名。
**旧 core**（没有 `SecretService.Put`）装不上这个包——清单 `sforumVersion` 会先拦下。

## 5. 兼容性判定

插件后端在 v2 握手时拿到宿主的 `coreVersion` / `buildVersion`，并把它们作为 `sforum` /
`sforumBuild` 转发给商城的目录与详情（**只有握手快照一个来源**：调用方带来的同名查询参数
一律丢弃，插件不推断、不硬编码宿主版本）。商城对每个版本的 `sforumVersion` 约束求值，返回
逐条 `compatibility` 与页级结论：

- `compatible` / `incompatible`：有判词，行内显示徽标；
- `unknown`：宿主没给版本（旧宿主、握手失败），目录不过滤、只展示每个扩展的约束文本，
  此时页面**不显示**兼容开关——过滤本来就不生效，放个开关只会骗人。

页面顶部有「只看当前版本可安装」开关，默认开启（请求带 `compat=compatible`，商城滤掉装不上的）；
关掉后切到 `compat=all`，列出全部并逐行打判词。判词与过滤都是商城的结论，core 在安装/启用
时的拒绝仍是最终裁判。

## 6. 已安装 / 可更新

插件后端通过宿主 Query `sforum.core.extensions.inventory.list`（能力 `extensions.read`）读取
**去敏**的已装清单（`id` / `version` / `type` / `status`），按扩展 id 与目录条目对齐：

- 命中：卡片与详情显示「已安装 v…」；`installed < latestVersion` 时再显示「可更新至 v…」；
  详情里额外说明 `disabled`（已在宿主停用）与 `installed`（已装、尚未启用）。
- 未命中 / 能力未授予 / 旧宿主：不显示任何已装信息，目录本身照常工作。

读取结果缓存 60 秒（失败也缓存，避免一次能力缺失让每个目录请求都等满超时）。徽标来源是
**宿主清单事实**，与安装流程的成功语义无关——后者仍然只写「已暂存」。

同一份清单还决定**安装门禁**：后端为每个版本算 `installedRelation`（`newer` / `same` /
`older` / `unknown`，与「可更新」同一个 semver 实现），页面据此决定安装条：

- 未安装 → 「安装到论坛」；选中版本更高 → 「更新到 vX」；
- 同版本 / 低于已安装 / 无法比较 → 主按钮降成禁用的「已安装 vX」，原因写在安装条的状态位里。
  页面**不提供卸载入口**：卸载是 core 的破坏性动作，不该放在浏览目录的手势路径上。

为什么不是页面上自己比版本：页面是零依赖手写 ESM，两套版本比较一定漂移。为什么阻断而不是
隐藏：core 对同 id 的包一律当候选暂存，同版本重装只是再下载一次 + 再确认一次信任，降级则
可能踩不可逆迁移；空位又会被读成页面坏了。**这是 UX 守卫，不是安全边界** —— 把签名链接粘到
core 的安装页仍然能装任意同 id 包。

## 6.1 作者信息

详情弹窗的 README 分区顶部有一条作者信息，来自商城 `author` 字段的两半（互不替补）：

- 论坛账号：显示名 + `@username`（`accounts.display_name` / `username`），其中 `@username`
  是指向论坛个人主页的链接（商城按 issuer 基址拼成 `<base>/u/<username>`，放在
  `author.profileUrl`；缺失时是纯文本）；
- GitHub 仓库账号：绑定仓库所属账号的 `@login`（`github_installations.account_login`），
  链接由插件用 login 重新拼成 `https://github.com/<login>`，不信上游整串 URL。

头像加载失败退字母块；两半都没有时整条不渲染。文案写「GitHub 仓库账号」而不是「作者」：
组织仓库属于组织，不是开发者本人。

## 7. 安装到底做了什么

1. 管理页向后端要 `{url, sha256, size, expiresAt}`（商城签名短链，30 分钟有效）。
2. 管理页调 `bridge.installExtension({url, sha256, expectedExtensionId, expectedType,
   expectedVersion})`；宿主做权限预检、弹自己的确认框、同步下载并校验摘要、比对清单身份。
3. 成功 = **已暂存（staged）**；启用与信任由管理员在 core 的扩展页面完成。
   安装流程的文案只写「已暂存」，不写「已安装」「已更新」「已验证构建」。
4. v1 是同步的：安装期间离开页面会取消（`install_cancelled`），所以页面写明
   「安装期间不要关闭页面」。

失败码（页面按 `error.code` 映射成中文；宿主语言是 `en-*` 时映射成英文）：`install_permission_denied`、
`install_cancelled`、`install_in_progress`、`install_invalid_request`、`install_failed`、
`extension.expected_mismatch`。

宿主的校验顺序决定了本机调试时最先看到哪一个：`bridge.installExtension` 先做客户端校验
（URL 必须是 `https:`、sha256 必须是 64 位小写 hex），不通过就返回
`install_invalid_request`，**连请求都不会发**；所以把商城地址填成 `http://…` 时页面报的是
「请求无效」，而不是下载失败。服务端的 `install-from-url` 另有自己的边界：只能取公网 HTTPS
（`AllowHTTP`/`AllowPrivate` 只在宿主测试里打开），本机回环地址会被它拒绝。

## 8. 网络要求

- 论坛服务器（插件进程）→ 商城：**出站 HTTPS**。目录、详情、签发三个代理都走它。
- 论坛服务器 → GitHub/对象存储：由**宿主**在安装时访问（插件不下载包）。
- 管理页：数据只走插件自己的同源路由（`/api/v1/extensions/sforum.store/api/store/*`），不发跨域
  请求、不加载外部字体。产品图标与品牌分享卡是唯一的外部资源：插件后端把它们拼成绝对地址
  （`<商城>/api/assets/<sha256>`），浏览器直连商城取图 —— 图片是公开的内容寻址资产，**不经过
  论坛做代理**（商城不进论坛请求链路）。加载失败按「分享卡 → 图标 → 字母块」逐级回退，不显示破图。
  若宿主管理页的 CSP 禁掉 `img-src` 到商城域名，表现就是「目录里全是字母块」，其余功能不受影响。

商城必须能从论坛服务器访问到，且证书有效；插件只接受 `https://` 基址（设置里填 `http://`
会被忽略并显示未配置）。

## 9. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 页面显示「还没配置商城地址」 | `catalog_base_url` 为空或不是 https | 到设置填写 https 基址 |
| 目录报「商城暂时不可用」 | 商城 5xx/超时/证书问题，或插件到商城不可达 | 在论坛服务器上 `curl <基址>/api/health`；看插件日志 |
| 提示「当前宿主不支持页面内安装」 | 宿主早于 `10c2b21e8`，没有 `bridge.installExtension` | 升级宿主，或复制签名链接到扩展安装页手动安装 |
| 安装报 `extension.expected_mismatch` | ZIP 里的清单与目录声明的 id/type/version 不一致 | 目录数据过期或包被换过；刷新目录后重试 |
| 安装报 `install_permission_denied` | 当前管理员没有扩展管理权限 | 交给有 `extension.plugin.manage` / `extension.theme.manage` 的管理员 |
| 目录顶部写「宿主没有暴露版本」 | 握手没带 `host_build`（旧宿主），或 `coreVersion` 为空 | 正常降级；升级宿主后判词与开关自动恢复 |
| 目录行没有「兼容 / 不兼容」 | 同上：没有宿主版本就没有判词 | 同上；core 在安装/启用时仍会兜底拒绝 |
| 开关「只看当前版本可安装」不见了 | 页级结论是 `unknown` | 设计如此：过滤不生效时不给假开关 |
| 看不到「已安装 / 可更新」 | 清单没声明 `extensions.read`、能力未授予，或宿主过旧 | 启用时确认能力已授予；旧宿主无此面 |
| 安装按钮变成「已安装 v…」且不可点 | 选中版本 ≤ 已装版本（同版本或降级），或两者有一个不是 semver | 要重装/降级到 core 的扩展页卸载；`unknown` 时到 core 的安装页处理 |
| 昵称后面的 `@用户名` 点不动 | 商城是旧版（没有 `author.profileUrl`），或该账号的 issuer 配置已被删 | 升级商城；`oauth_issuers` 里要保留登录来源的基址 |
| 更新说明显示成 `## 标题` 这样的字面量 | 商城是旧版，没有 `notesHtml`；页面按纯文本回退 | 升级商城；这是有意的降级路径，不是渲染失败 |
| 作者信息整条不见了 | 商城是旧版（没有 `author`），或产品既没绑论坛账号也没绑仓库 | 升级商城；绑定产品仓库后重进详情 |
| 清单没有项目符号，只剩缩进 | 宿主 `dist` 还是旧构建（`list-style` 由插件 CSS 补回） | 重新 `bash plugin/scripts/build.sh` 并让宿主切到新制品 |
| 数据带「更新于 X」 | 商城不可达，用了 24 小时内的缓存 | 恢复商城连通性后刷新 |

## 10. 构建与校验（仓库内）

```bash
bash plugin/scripts/build.sh                       # Go 二进制 + 管理页 + 摘要 + 清单校验
cd plugin/plugins/sforum.store/backend && go test ./...
bun test plugin/plugins/sforum.store/frontend/admin/src
```

`brand/` 下的图标与社交卡由 SForum 仓的 `scripts/brand/` 生成（spec 里登记为 external 条目），
不进 `packageFiles`，但会改变包树摘要，所以改完要重新 `extension package`。

发布前用宿主自己的命令过闸（只读使用 SForum 检出）：

```bash
cd <SForum>/apps/api
go run ./cmd/sforum extension validate <pkg>
go run ./cmd/sforum extension test <pkg>
go run ./cmd/sforum extension brand check <pkg>
go run ./cmd/sforum extension package <pkg> --exclude-source -o /tmp/sforum.store.zip
```

推 `v*` tag 时 `.github/workflows/release.yml` 会自动跑上面四道闸，并按
`linux/amd64`、`linux/arm64`、`darwin/arm64`、`darwin/amd64` 四个平台重建后端、刷新摘要、
打包，把 ZIP、SBOM 与 `SHA256SUMS` 挂到该 tag 的 GitHub Release。标签版本必须与
`sforum.extension.json` 的 `version` 一致。
