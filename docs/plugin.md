# 商城插件 `sforum.store`

插件把商城目录搬进论坛后台，并把选中的包交给**宿主**安装。它不启用、不信任、不升级任何扩展，
也不保存论坛 token 或包体。

## 1. 宿主要求

页面内安装依赖宿主的**页面级宿主动作**（清单 `hostActions: ["extension.install"]` +
`bridge.installExtension`），落地于 SForum `10c2b21e8`（2026-10-24）。更旧的宿主会拒绝
含 `hostActions` 的清单。插件本身会特性检测：宿主没有这个 bridge 成员时，安装按钮隐藏，
只提供可复制的签名链接。

## 2. 安装

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

开发装配只用于本地；生产用方式 A。

## 3. 设置

论坛后台 → 应用商城 → 设置（Schema UI，两个字段）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `sforum.store.catalog_base_url` | 空 | 商城基址（https）。**留空时管理页只显示配置提示，不发任何请求** |
| `sforum.store.channel` | `stable` | 目录默认频道；`stable` 只列稳定版，`beta` 含预发布 |

设置值由插件后端通过宿主的 own-settings 查询读取，缓存在进程内 60 秒；管理员改完设置后
最迟一分钟生效（重开管理页即可）。

## 4. 安装到底做了什么

1. 管理页向后端要 `{url, sha256, size, expiresAt}`（商城签名短链，30 分钟有效）。
2. 管理页调 `bridge.installExtension({url, sha256, expectedExtensionId, expectedType,
   expectedVersion})`；宿主做权限预检、弹自己的确认框、同步下载并校验摘要、比对清单身份。
3. 成功 = **已暂存（staged）**；启用与信任由管理员在 core 的扩展页面完成。
   页面文案只写「已暂存」，不写「已安装」「已更新」「已验证构建」。
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

## 5. 网络要求

- 论坛服务器（插件进程）→ 商城：**出站 HTTPS**。目录、详情、签发三个代理都走它。
- 论坛服务器 → GitHub/对象存储：由**宿主**在安装时访问（插件不下载包）。
- 管理页：数据只走插件自己的同源路由（`/api/v1/extensions/sforum.store/api/store/*`），不发跨域
  请求、不加载外部字体。产品图标是唯一的外部资源：插件后端把它拼成绝对地址
  （`<商城>/api/assets/<sha256>`），浏览器直连商城取图 —— 图片是公开的内容寻址资产，**不经过
  论坛做代理**（商城不进论坛请求链路）。加载失败时退回字母块，不显示破图。
  若宿主管理页的 CSP 禁掉 `img-src` 到商城域名，表现就是「目录里全是字母块」，其余功能不受影响。

商城必须能从论坛服务器访问到，且证书有效；插件只接受 `https://` 基址（设置里填 `http://`
会被忽略并显示未配置）。

## 6. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 页面显示「还没配置商城地址」 | `catalog_base_url` 为空或不是 https | 到设置填写 https 基址 |
| 目录报「商城暂时不可用」 | 商城 5xx/超时/证书问题，或插件到商城不可达 | 在论坛服务器上 `curl <基址>/api/health`；看插件日志 |
| 提示「当前宿主不支持页面内安装」 | 宿主早于 `10c2b21e8`，没有 `bridge.installExtension` | 升级宿主，或复制签名链接到扩展安装页手动安装 |
| 安装报 `extension.expected_mismatch` | ZIP 里的清单与目录声明的 id/type/version 不一致 | 目录数据过期或包被换过；刷新目录后重试 |
| 安装报 `install_permission_denied` | 当前管理员没有扩展管理权限 | 交给有 `extension.plugin.manage` / `extension.theme.manage` 的管理员 |
| 目录顶部写「本页只展示 sforumVersion 约束」 | 宿主没有暴露自身版本（D9），商城无法判断兼容 | 正常现象；行内不再逐条打判词，改显示每个扩展最新版本的约束，core 安装时会兜底拒绝 |
| 目录行没有「兼容 / 不兼容」 | 同上：没有宿主版本就没有判词 | 同上。D9 放开后插件后端会转发 `sforum` / `sforumBuild`，判词自动恢复 |
| 数据带「更新于 X」 | 商城不可达，用了 24 小时内的缓存 | 恢复商城连通性后刷新 |

## 7. 构建与校验（仓库内）

```bash
bash plugin/scripts/build.sh                       # Go 二进制 + 管理页 + 摘要 + 清单校验
cd plugin/plugins/sforum.store/backend && go test ./...
bun test plugin/plugins/sforum.store/frontend/admin/src
```

发布前用宿主自己的命令过闸（只读使用 SForum 检出）：

```bash
cd <SForum>/apps/api
go run ./cmd/sforum extension validate <pkg>
go run ./cmd/sforum extension test <pkg>
go run ./cmd/sforum extension package <pkg> --exclude-source -o /tmp/sforum.store.zip
```
