# GitHub App 用 Manifest 一键注册

Status: accepted
Date: 2026-10-25

## 背景

S2 起，商城要运营方自己在 GitHub 上手工建一个 App，再把四样东西搬回后台：App ID、slug、
webhook secret、私钥 PEM；另外还要在 GitHub 侧抄三个地址（Homepage、Webhook URL、Setup URL），
勾三项权限、订四个事件。`docs/github-app.md` §1 那张检查单就是这条路径的全文。

写完之后回头看，问题不在文档措辞，在流程本身：

1. **四个值必须人肉搬运。** 其中三个（slug、webhook secret、私钥）错一位都不会当场报错——
   slug 错只让安装页 404，secret 错只让投递 401 `invalid_signature`，事件少订只让仓库改名后
   静默失效。§8 排查表的前三条正好是这三个坑：**排查表在给流程兜底，说明坑是流程自带的。**
2. **文档漏了一个会致命的开关。** 检查单里没有「Public / Private App」。App 建成 Private 时
   只有 App 所有者能安装它，而开发者要把 App 装到**自己**的仓库上——绑定流程直接死。手工建
   App 时几乎没人会注意这个默认值。
3. **每次部署都要重走一遍。** 商城是独立服务端、服务多个论坛，每个部署一个 App，运营方换人
   就要重新教一次。

GitHub 自己有官方解法：**App Manifest flow**。我们把一份预配置的 manifest POST 给 GitHub，
操作者只需确认 App 名字，GitHub 把 App 建好并把 `id` / `slug` / `pem` / `webhook_secret`
直接交回来。

## 决定

后台 GitHub App 页新增「0. 一键创建（推荐）」，走 manifest flow；下面的手动表单保留，用于
**GitHub Enterprise Server** 与**接管一个已经存在的 App**（manifest 只能新建，不能接管）。

协议三步（官方文档：`docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest`）：

1. 浏览器 POST 表单到 `https://github.com/settings/apps/new?state=<签名 state>`（组织账号走
   `/organizations/<owner>/settings/apps/new`），字段 `manifest` 是 JSON 字符串。
2. 操作者在 GitHub 页面上确认 App 名字，GitHub 跳回
   `<publicUrl>/api/github/manifest/callback?code=…&state=…`。
3. 服务端 POST `https://api.github.com/app-manifests/<code>/conversions`，拿回凭据并写库。

落地的四个新件：

- `lib/github/manifest.ts` —— 纯协议层：manifest 构造、state 编解码、code 兑换（含响应校验）。
  没有数据库、没有 Next，可单测。
- `POST /api/admin/github-app/manifest/start` —— 管理员 + 同源校验，返回 `actionUrl` 与
  manifest JSON，并下发签名 state cookie。**不返回 303**：GitHub 要的是 POST body，重定向会丢掉它。
- `GET /api/github/manifest/callback` —— 验 state、验会话、兑换、写库、顺手 `verifyGithubApp`，
  最后 303 回后台并带一个 reason code。
- `replaceGithubAppFromManifest()` —— 写库用替换语义。

## 关键取舍

**1. state 绑管理员，因为 conversions 端点不认证。**
`POST /app-manifests/{code}/conversions` 没有认证要求——code 本身就是凭据。所以真正的边界是：
state 必须由**发起创建的那个管理员**持有。state 用 `sessionSecret` 签名、一小时过期、装在
`__Host-store_github_manifest`（SameSite=Lax，顶层 GET 回跳会带上），回调里再比一次
`session.admin.id`。没有这一层，任何拿到回调 URL 的登录管理员都能把别人的 App 写进配置。

**2. 替换，不是合并。**
manifest 永远产出**新** App。旧 App 的私钥必须跟着旧配置一起消失：一把签不出 JWT 的私钥如果
留在列表里，界面会把它显示成可用的「备用」，等于给运营一个按下去没反应的回滚。所以先删行
（`github_app_private_keys` 级联），再按「首次保存」写入。审计留两条：`removed`（带
`via: manifest` 与 `replacedBy`）+ `created`，不新增 action 词汇。

**3. `public: true` 写死。**
不是风格问题：Private App 只有所有者能安装，而开发者要装到自己的仓库。manifest 里把它写成
常量，顺手把手工路径漏掉的这个开关变成代码事实。

**4. 权限与事件写死在代码里。**
`contents: read` / `metadata: read` / `actions: read`，事件只声明 `release` 与 `repository`。
代价是以后加权限要改代码重发一次，而不是后台点一下；换来的是「不会漏订 `repository`」这件事由
测试保证，而不是由人记得。

事件这一格踩过一次：第一版把 `installation` 与 `installation_repositories` 也写进了
`default_events`，GitHub 直接拒绝整份 manifest ——
`Default events unsupported: installation and installation_repositories` /
`Default events are not supported by permissions: …`。这两个是 App 生命周期的**恒定投递**事件
（装、卸、改仓库授权时必然送达，所以 App 才有机会知道自己被安装），既不能订阅也不需要订阅；
写上去只会让整份 manifest 失效。`manifest.test.ts` 里有一条专门的回归断言盯着它。

**5. 只支持 github.com。**
GHES 的握手端点在自己主机上（`https://HOST/settings/apps/new` +
`https://HOST/api/v3/app-manifests/{code}/conversions`），`webHostFor()` 能推导，但这条路径
没有环境可验证。start 路由遇到非 github.com 的 `apiBaseUrl` 直接 409
`manifest_requires_github_dot_com`，指向下面的手动表单——**明说不支持，好过半work**。

**6. 失败只回 reason code。**
回调是浏览器顶层导航，回 JSON 等于把一个人扔在裸接口上。所以一律 303 回后台
`?manifest=failed&reason=…`，文案在表单里。code 一次性且一小时过期，重来一次是两次点击的事。

## 未验证

- **GitHub 侧真的接受这份 manifest。** 兑换端点与表单 POST 的形状来自官方文档；实际提交需要
  一个登录了 GitHub 的浏览器点一次「Create GitHub App」。本次验证环境没有 GitHub 登录态，
  未点。若字段名有误，表现是 GitHub 创建页直接报错，不会建出半成品 App。
- **GHES 的 manifest 端点。** 代码里能推导地址，但没有 GHES 实例。
- **本地 `http://127.0.0.1` 作为 `redirect_url`。** 官方文档未声明限制，未实测。生产不需要：
  webhook 本来就必须公网 HTTPS，回调地址与它同源。

## 后果

- 新部署的运营动作从「12 步 + 三类静默坑」变成「点两次」。`docs/github-app.md` 的检查单降级为
  GHES / 接管已有 App 的路径。
- 新增错误码：`manifest_requires_github_dot_com`、`manifest_missing_code`、
  `manifest_exchange_failed`、`manifest_invalid_response`、`invalid_owner`。
- 手工表单与一键创建写的是同一行、同一个 keyring、同一条审计链——不存在两套状态。
