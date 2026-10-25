# GitHub App Manifest 一键注册

Date: 2026-10-25
Status: 交付，待人工在 GitHub 侧点一次确认

## 为什么做

手工注册 GitHub App 要人肉搬四个值（App ID、slug、webhook secret、PEM）+ 抄三个地址 + 勾权限 +
订事件。其中三处错一位都不当场报错（slug 错只让安装页 404、secret 错只让投递 401、少订
`repository` 只让改名后静默失效）——`docs/github-app.md` §8 排查表的前三条正好是这三个坑，
说明坑是流程自带的。另外检查单漏了 **Public / Private App**：Private 只有所有者能安装，而开发者
要装到自己的仓库上，绑定流程会直接死。

GitHub 官方解法是 App Manifest flow。取舍与未验证项见
`decisions/2026-10-25-github-app-manifest-flow.md`。

## 落地

- `lib/github/manifest.ts` —— 纯协议层：`buildGithubAppManifest` / `encodeManifestState` /
  `decodeManifestState` / `exchangeManifestCode` / `webHostFor` / `manifestStartUrl` /
  `defaultAppName`。无数据库、无 Next，可单测。
- `POST /api/admin/github-app/manifest/start` —— 管理员 + 同源；返回 `actionUrl` + manifest JSON，
  下发签名 state cookie（`__Host-store_github_manifest`，1 小时）。**故意不 303**：GitHub 要 POST
  body。非 github.com 的 `apiBaseUrl` 直接 409 `manifest_requires_github_dot_com`。
- `GET /api/github/manifest/callback` —— 验 state → 验「同一管理员会话」→ 兑换 code →
  `replaceGithubAppFromManifest` → 顺手 `verifyGithubApp` → 303 回后台带 reason code。
- `replaceGithubAppFromManifest()`（`lib/github/app-config.ts`）—— 替换语义：先删行（私钥级联），
  再按「首次保存」写入；审计留 `removed`（`via: manifest` + `replacedBy`）+ `created` 两条。
- 后台页新增「0. 一键创建（推荐）」区块（组织可选 + 按钮 + 回跳结果横幅），下面原有五节保留。
- `docs/github-app.md` 重排：§1 一键创建（含「它会替你写死什么」表与 Public 说明），§2 手动检查单
  补上 Public/Private 行，§9 排查新增四条 manifest 相关现象。

## 验证

- `bun test --parallel=1`：**556 pass / 51 files**（新增 18 条：`manifest.test.ts` 16 条 +
  `app-config.test.ts` 里 `replaceGithubAppFromManifest` 2 条）；`tsc` 干净；`bun --bun next build`
  通过，`/api/admin/github-app/manifest/start` 与 `/api/github/manifest/callback` 都在路由表里。
- 生产构建实例（`next start -p 4100`）实测 `POST /api/admin/github-app/manifest/start`：200，
  `actionUrl` 正确带 state、组织路径正确、manifest 七项与设计一致。
- 隧道域浏览器实测（1633×810 与 390×844 截图在 `/tmp/manifest-{pc,mobile}.png`）：页面渲染正常、
  390 无横向溢出；点击按钮 → `fetch /manifest/start` 200 → 表单 POST 到
  `https://github.com/settings/apps/new?state=…` → GitHub 回 `login?return_to=…/settings/apps/manifest`
  （GitHub 认出了这是 manifest 注册请求，只是本机浏览器没有 GitHub 登录态）。

## 未验证

- **GitHub 真的接受这份 manifest**：需要登录 GitHub 的人在创建页点一次 **Create GitHub App**。
  字段若有误，表现为创建页直接报错，不会留下半成品 App。
- GHES 的 manifest 端点（代码能推导地址，无实例）。
- 本地 `http://127.0.0.1` 作为 `redirect_url`（官方文档未声明限制，未实测）。

## 第一次真实点击的反馈（2026-10-25 04:54）

GitHub 拒绝了第一版 manifest，两条红字：

```
Error  Default events unsupported: installation and installation_repositories
Error  Default events are not supported by permissions: installation and installation_repositories
```

`installation` / `installation_repositories` 是 App 生命周期的**恒定投递**事件（装、卸、改仓库
授权时必然送达），既不能订阅也不需要订阅，写进 `default_events` 会让整份 manifest 失效。
`MANIFEST_EVENTS` 已收窄为 `["release", "repository"]`，webhook 处理端不变——那两个事件照样会来。
新增一条回归断言（`manifest.test.ts` 的「never names the installation lifecycle events」），
文档与 AGENTS.md 的事件清单同步改成「要订的两个 + 恒定投递的两个」。

这次失败**没有**在 GitHub 上留下 App，也没有写进 `github_app_config`：校验发生在创建之前。

## 第二次真实点击：state 校验写错了（已修）

manifest 通过校验、GitHub 把 App 建出来了，但回调一律 `?manifest=failed&reason=state`。

根因是一处**比较对象错了**的 state 检查：cookie 里存的是我们签发的整串签名 token，查询串里
`state=` 也是同一串；代码却拿 `decode(cookie).nonce`（一个 UUID）去和整串比 —— 永远不等，所以
每次回调都在第一道闸门被拒。**同一个 bug 在 `/api/github/setup`（安装回调）里也存在**：那里的
`payload.nonce !== state` 同样恒真，意味着安装重定向从来没成功过，installation 一直只是靠
webhook 记录（所以没人发现）。

修法：两处都换成 `verifyManifestState(cookie, queryState, secret)` /
`verifyInstallState(...)` —— 先比「查询串是否就是 cookie 那串」（证明这次回调属于这个浏览器的
流程，否则攻击者的 code 可以借管理员的 cookie 完成），再验签名与过期。两个 helper 都有回归断言
（含「裸 nonce 不算 token」这一条）。

**代价**：前两次点击在 GitHub 上留下了真实的 App（拿到了 code 就说明建成了），但私钥只在那一次
响应里返回过、已被丢弃，所以那两个 App 对本部署无用，要去 GitHub 删掉再重来。

## 环境改动（重要）

1. `service/.env.local` 追加了 `STORE_DEV_ORIGINS=test-sforum-app-store.dalao.me`。
   **没有它，隧道域下页面能开但完全不 hydrate**（`next dev` 对 `/_next/*`、`__nextjs*` 的跨站请求
   返 403），按钮点了没反应——本次排查就卡在这。该文件已被 `.gitignore` 忽略。
2. 本机 dev 服务重启过（之前的进程被我跑 `next build` 冲掉了 Turbopack 缓存，新路由 500
   `internal_error`，旧路由正常）。现在以 `nohup bun run dev > /tmp/sforum-dev.log 2>&1` 运行，
   **日志在 `/tmp/sforum-dev.log`，不再打到原终端**。
3. 验证用的临时管理员会话已删除；4100 上的临时生产实例已关闭。
