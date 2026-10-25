# GitHub App（后台配置）

商城用 **GitHub App** 访问仓库：不存 PAT，只签发 installation token。App 的凭据是**运行时配置**，
登录后台填，不读 env。

- 商城侧入口：`${STORE_PUBLIC_URL}/${STORE_ADMIN_PATH}/settings/github`（默认 `/admin/settings/github`）。
- 两条路，写的是同一行：**① 一键创建**（GitHub.com，推荐）与**② 手动填写**（GitHub Enterprise
  Server，或接管一个已经存在的 App）。取舍见
  `knowledge/decisions/2026-10-25-github-app-manifest-flow.md`。
- 数据落在 `github_app_config` + `github_app_private_keys`：webhook secret 与私钥用
  `STORE_SECRET_KEYS` 加密，界面只显示「有没有配」和公钥指纹，不回显任何密文或私钥。
- 为什么不在 env：App ID、slug、webhook secret、私钥都是运营方会轮换的东西，改 `.env` 要 web 与
  worker 一起重启；现在保存即生效——两个进程各自在 15 秒内读到新配置（进程内缓存），不需要重启。
- 读写只有一个口：`service/src/lib/github/app-config.ts`。

## 1. 一键创建（GitHub.com，推荐）

后台页面最上面的「0. 一键创建」：

1. 「组织（可选）」留空即建在**你自己的 GitHub 账号**下；填组织名即建在该组织下（你必须是该
   组织里能创建 App 的成员）。
2. 点「用 GitHub 创建并填好」→ 跳到 `github.com` 的创建页，名字已预填（`sforum-store-<host>`，
   可以改）。
3. 点 **Create GitHub App** → GitHub 建好 App 并把浏览器跳回本页，凭据已经写进配置。

这一步之后**不用再碰第 2、3 节**：App ID、slug、webhook secret、私钥都由 GitHub 在创建时直接
交给服务端，没有任何值经过人手。

### 它会替你写死什么

| 项目 | 值 |
| --- | --- |
| Homepage URL | 商城生效的对外地址 |
| Webhook URL | `<对外地址>/api/github/webhook`，Content type `application/json` |
| Setup URL | `<对外地址>/api/github/setup`（不是 Callback URL） |
| Redirect URL（握手回跳） | `<对外地址>/api/github/manifest/callback` |
| 权限 | `Contents: read`、`Metadata: read`、`Actions: read`；**不要** `Administration` |
| 事件 | `release`、`repository`、`push`。安装类事件（`installation` / `installation_repositories`）**不能写进 manifest**：GitHub 恒定投递给每个 App，写上去会让整份 manifest 报错 |
| Public / Private | **Public** |

- **Public 不是可选项。** Private App 只有 App 所有者能安装，而开发者要把 App 装到自己的仓库上；
  建成 Private 会让绑定流程直接死。
- **替换语义。** manifest 只能新建 App，接管不了已有的那个。所以一键创建会**替换**当前配置：旧
  配置连同它的私钥一起被清掉（审计里能看到 `removed` + `created` 两条），装过的仓库要重装一次。
- **一小时、一次性。** 握手要在一小时内完成，`code` 只能兑换一次。中途放弃或失败，重新点一次即可；
  如果上一次已经在 GitHub 上建出了 App，先去 GitHub 删掉它。
- **失败会回到本页并说明原因**（`?manifest=failed&reason=…`），文案在页面横幅里。服务端日志里
  的关键字是 `[github] manifest callback`。

## 2. 手动注册检查单（GHES / 接管已有 App）

一键创建只支持 github.com。以下情况走手动路径：GitHub Enterprise Server；或者 App 已经在
GitHub 上存在（manifest 只能新建，不能接管）。

| 项目 | 值 |
| --- | --- |
| Homepage URL | 商城生效的对外地址（后台「系统设置」里显示，或 `/api/health` 的 `publicUrl`） |
| Webhook URL | `<对外地址>/api/github/webhook`（由生效地址推导，后台表单里直接复制）；Content type 选 `application/json` |
| Webhook secret | `openssl rand -hex 32`；两边逐字一致 |
| Setup URL（安装后跳转，不是 Callback URL） | `<对外地址>/api/github/setup` |
| 权限 | `Contents: read`、`Metadata: read`、`Actions: read`；**不要** `Administration` |
| 事件 | 勾 `release`、`repository`、`push`。安装类事件（`installation` / `installation_repositories`）在 App 设置页**没有勾选项**，GitHub 恒定投递，不用管 |
| **Public / Private** | **必须是 Public**（App 设置页底部）。Private 只有所有者能安装，开发者装不到自己的仓库上 |
| 私钥 | App 页面 **Generate a private key**，下载 `.private-key.pem`（PEM，未加密；PKCS#8 与 PKCS#1 都收） |

- 少订 `repository` 会让仓库改名/转移/转私有**静默失效**：webhook 不再来，本地镜像还是旧名字。
- 少订 `push` 只影响品牌图实时性：改了 `brand/icon.png` 不会立刻生效，要等发版或次日巡检。
  商城对 `push` 的过滤在写库之前完成（默认分支 + 命中 `brand/` 才算），其余投递不入库。
- **已安装的 App 不会自动获得新事件。** 升级到带 `push` 的版本后，App 设置页 → Permissions &
  events → Subscribe to events 手动勾上 `push`；manifest 一键创建只对新建的 App 生效。
- `Actions: read` 只用于审核页展示 release 所指 commit 的 workflow run，不是发布闸门，界面不写
  「已验证构建」。

## 3. 填进后台

页面分六节：① 一键创建 ② webhook 地址、Setup URL 与安装链接（只读、可复制）③ 凭据 ④ 私钥与
轮换 ⑤ 验证 ⑥ 移除配置。第 ② 节的 Webhook URL 与 Setup URL 由**生效的对外地址**推导
（`lib/github/app-config.ts` 的 `webhookUrlFor` / `setupUrlFor`），页面上复制，不要手打；
安装链接由 slug 拼，要等 slug 存下去才生成。
改对外地址在后台「系统设置」（`/<STORE_ADMIN_PATH>/settings/general`）里改，保存即生效，不用重启；
改完把 GitHub App 页里的 Webhook URL 与 Setup URL 同步过去。

| 后台字段 | 从哪来 | 约束 |
| --- | --- | --- |
| App ID | App 页面顶部 | 正整数，不是 `client_id` |
| slug | `github.com/apps/<slug>` 里那段 | 字母、数字、连字符，首位非连字符，≤ 64 |
| API base URL | 只有 GitHub Enterprise Server 才改 | 生产必须 `https`（`127.0.0.1` / `localhost` 例外）；留空即 `https://api.github.com` |
| webhook secret | 检查单里那个值 | 16–256 字符；已设置时留空表示不修改，保存后只显示「已设置」 |
| 私钥 | `.private-key.pem` 内容整段粘贴 | 未加密 RSA PEM（PKCS#8 或 PKCS#1）；不用 base64，JSON 转义的 `\n` 与 CRLF 会自动归一 |

- 按钮是「保存并启用」（首次）/「保存修改」（之后）。
- 首次保存必须同时有 webhook secret 与私钥，缺了分别报 `missing_webhook_secret` /
  `missing_private_key`；之后留空表示「这一项不改」。
- 私钥的身份是**公钥 SPKI 的 SHA-256 指纹**（GitHub 页面的 key id 无法从文件推导，指纹才是可
  比对的），后台用指纹前 12 位作标签；列表里标「签名中」的是最新添加的那把，其余标「备用」。
- 同一把私钥重复粘贴返回 `key_exists`，不是错误操作——说明它已经在列表里。

## 4. 验证

点第 ⑤ 节的「验证」：用 App JWT 调 `GET /app`（8 秒超时）。一次验三件事——App ID 存在、私钥是
配对的那把、后台存的 slug 与 App 真实 slug 一致。一键创建在写库之后**自动跑一次**，所以正常情况
下页面直接显示「已连通」。

| 结果 | 说明 |
| --- | --- |
| 「已连通：<name>（<slug> · <owner>）」 | 三项都对 |
| 「App 可访问，但 slug 不匹配…安装链接会 404」 | 表单不校验 slug，这是最容易漏的一格 |
| 「连接超时」 | 出站到 GitHub API 不通（代理、防火墙、GHES 地址） |
| 「验证失败：…」 | JWT 签名、App ID 或私钥不对 |

结果写回 `last_verified_at` / `last_error` 并记审计。**保存任何字段都会清空上次验证结果**，所以
改完必须重验——后台不会让一个没验过的 App ID 顶着旧的「已连通」。

## 5. 轮换 webhook secret

1. `openssl rand -hex 32` 生成新值。
2. 后台把新值填进 webhook secret 保存（写-only：保存即用新密文替换旧密文）。
3. GitHub App 页面把 Webhook secret 改成同一个值。
4. 两步之间有一段窗口：旧 secret 签的投递一律 `401 invalid_signature`。验签发生在写
   `webhook_deliveries` 之前，所以这些投递**不入库、不占幂等键**；窗口内丢掉的事件需要重新触发
   一次（例如再发一个 release）。
5. 之后点「验证」确认 App 仍连通（验证用私钥、不用 secret，但顺手确认配置没写坏）。

## 6. 轮换私钥（先加后删）

GitHub 允许一个 App 同时挂多把私钥，商城也支持多把：**最新添加的那把签名**。所以顺序固定：

1. GitHub App 页面 → **Generate a private key**，下载新的 `.private-key.pem`，**旧的不动**。
2. 后台第 ④ 节「添加私钥」→ 粘贴 PEM → 「添加」，确认新指纹出现在列表且标「签名中」。
3. 点「验证」通过后，再删旧的：后台那一行点「删除」，然后回 GitHub 页面删对应那把。
4. **最后一把不能删**：只剩一把时「删除」是禁用的，接口也会返回 `409 last_key`——没有签名私钥
   就签不出 App JWT，后台自己的「验证」按钮也救不回来。

## 7. 没配置 / 读不出来时

没配 App（`github_app_config` 无行）时：

| 位置 | 表现 |
| --- | --- |
| `POST /api/github/webhook` | `503 github_not_configured` |
| `GET /api/github/install/start`、`GET /api/github/setup` | `503 github_not_configured` |
| `POST /api/dashboard/github/repos/refresh`（「从 GitHub 同步」） | `503 github_not_configured` |
| `GET /api/v1/download/{token}`（下载代理） | `503 github_not_configured` |
| worker | **照常启动**，日志 warn：`[worker] GitHub App is not configured; release jobs will fail until it is` |

配了但用不了，是两个不同的错误码，都在 webhook 上按 503 出来，**不要**当成「未配置」：

| code | 含义 | 修法 |
| --- | --- | --- |
| `github_config_incomplete` | 有 App 行但一把私钥都没有 | 上传一把私钥 |
| `github_config_unreadable` | 密文解不开：`STORE_SECRET_KEYS` 里缺当时的 kid | 把旧 kid 加回 keyring 并重启；或在后台重新保存 webhook secret 与私钥（用当前 keyring 重新加密） |

webhook 之外的路径只区分「未配置」与「其它错误」：后者是 5xx，原因在服务端日志（下载代理会记
`[download] upstream fetch failed`，然后对外仍是 `503 upstream_unavailable`）。

**keyring 轮换要当心**：私钥与 webhook secret 是用**写入时那把 kid** 加密的。从
`STORE_SECRET_KEYS` 删掉一个还在用的 kid，集成会以 `github_config_unreadable` 停摆，而不是悄悄
退回「未配置」。轮换顺序：新 kid 追加在**列表末尾**（加密用最后一把）→ 后台重新保存一次 App →
确认旧 kid 没有其它密文依赖 → 再删旧 kid。

## 8. 审计与状态

- 每次保存 / 添加私钥 / 删除私钥 / 验证 / 清空配置 / 一键创建都写审计，目标类型 `github_app`，在
  后台「审计日志」里按目标类型 **GitHub App** 筛：

| action | 触发 |
| --- | --- |
| `admin.github_app.created` | 首次保存，或一键创建写入 |
| `admin.github_app.updated` | 改 App ID / slug / API base URL / webhook secret |
| `admin.github_app.key_added` | 添加私钥 |
| `admin.github_app.key_removed` | 删除私钥 |
| `admin.github_app.verified` | 点「验证」，以及一键创建后的自动验证 |
| `admin.github_app.removed` | 清空配置；一键创建替换旧 App 时也会先记一条（details 带 `via: manifest`） |

- 审计 details 只记「改了什么」：appId、slug、apiBaseUrl、是否轮换了 webhook secret、新增私钥的
  id、验证结果与消息。**不记 secret，不记私钥**。
- 第 ⑥ 节的「移除配置」不删 installation 与已同步的仓库行：它们是历史，重新填同一个 App 会直接接上。
- 后台「系统健康」的配置面板常显：appId、slug、私钥把数、webhook secret 是否已设、上次验证时间，
  以及 `readError` / `lastError`。

## 9. 排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| webhook 全 `401 invalid_signature` | 两边 webhook secret 不一致 | 后台与 GitHub 改成同一个值，再重触发一次事件 |
| 安装链接 404（`github.com/apps/<slug>/installations/new`） | 后台 slug 与 App 真实 slug 不一致 | 改 slug → 「验证」 |
| 开发者看不到自己的仓库 / 装不上 | App 是 Private | App 设置页改成 Public |
| webhook `503 github_config_unreadable` | keyring 缺 kid | 见 §7 |
| webhook `503 github_config_incomplete` | 没上传私钥 | 见 §7 |
| 审核页的 Actions 提示一直是空的 | App 没有 `Actions: read`，或 release 所指 commit 没有 workflow run | 补权限；这条提示是可选信息，取不到就渲染为空，不影响审核判断 |
| 仓库改名/转移/转私有后不再同步 | 少订 `repository` 事件 | 在 App 页面补订，再重新同步一次 |
| 点「一键创建」报「只支持 github.com」 | 存了 GHES 的 API base URL | 用下面的手动填写 |
| GitHub 创建页红字 `Invalid GitHub App configuration` | manifest 里有 GitHub 不接受的字段，最常见是把 `installation` / `installation_repositories` 写进 `default_events` | 它们恒定投递、不能声明；本仓已移除（`lib/github/manifest.ts` 的 `MANIFEST_EVENTS`），报这个说明部署的是旧构建 |
| 一键创建回来说「code 已经用过或已过期」 | 超过一小时，或回调被重复打开 | 重新点一次；上一次建出的 App 若已存在，先去 GitHub 删掉 |
| 一键创建回来说「状态校验失败」/「会话对不上」 | state cookie 过期（一小时）、被篡改，或中途换了管理员/掉登录 | 重新登录后再点一次 |

## 10. 从 env 迁移（2026-10-25）

旧部署写在 env 里的 `GITHUB_APP_ID` / `GITHUB_APP_SLUG` / `GITHUB_WEBHOOK_SECRET` /
`GITHUB_APP_PRIVATE_KEYS` / `GITHUB_API_BASE_URL` **已不再读取**（不是「优先用 env」）。升级后必须
按 §1（GitHub.com，两次点击）或 §2–§3（GHES / 已有 App）在后台重新填一次，否则 webhook 503、
仓库与下载功能不可用。填完把那几行从 `.env` 删掉：留着只会误导下一个人。
