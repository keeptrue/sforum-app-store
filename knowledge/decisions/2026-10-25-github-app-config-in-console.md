# GitHub App 配置从 env 迁到后台（数据库）

Status: accepted
Date: 2026-10-25

## 背景

S2 把 GitHub App 的四项凭据（`GITHUB_APP_ID` / `GITHUB_APP_SLUG` / `GITHUB_WEBHOOK_SECRET` /
`GITHUB_APP_PRIVATE_KEYS`）和测试用的 `GITHUB_API_BASE_URL` 全部放在 env。当时的理由是「私钥
只从环境/密钥管理读取」——少一个能把私钥读出来的口子。

实际运行下来这个选择的代价越来越明显：

1. **这些值不是部署常量，是运营配置。** 换 App（测试 App → 正式 App）、轮换 webhook secret、
   轮换签名私钥、临时指向 GHES，都是运营动作，频率远高于「重启一次」。
2. **改 env 要协调两个进程。** web 与 worker 是同一镜像的两个进程；改 env 必须两边同时重启，
   而滚动重启期间 webhook 会用旧 secret 验签（GitHub 侧已经换了新 secret），这段时间的投递
   全部 401，且 GitHub 不会自动重投已签发的失败投递。
3. **没有任何界面能看到「现在用的是哪个 App」。** `/admin/system` 的「配置自检」只能回答
   「配没配」，回答不了「app id 是多少、slug 对不对、私钥是哪一把」。slug 写错不会立刻报错，
   要等到开发者点安装、GitHub 返回 404 才发现。
4. **私钥轮换没有落点。** 多私钥（`kid:base64pem` 逗号分隔）在 env 里是字符串拼装，加一把、删
   一把都要重新拼整行，且没有任何校验——粘贴错一把，App JWT 全线失败。

同时期 issuer 已经走完同样的迁移（`oauth_issuers` 表 + 后台「OAuth2 配置」，见
`2026-10-25-admin-local-identity.md`），路径被验证过：**配置进库、secret 用 keyring 加密、
后台表单写入、审计留痕**。

## 决定

GitHub App 的配置只有一个来源：数据库，写入口只有后台。

- 表：`github_app_config`（单行，`github_app_config_singleton_idx` 用 `(true)` 表达式唯一索引
  保证「一个部署一个 App」）+ `github_app_private_keys`（`config_id` 外键级联删除，`app_key_id`
  唯一，`fingerprint` 是公钥 SPKI 的 SHA-256）。
- 加密：webhook secret 与每把私钥都用 `STORE_SECRET_KEYS`（keyring）加密成
  `v1.<kid>.<iv>.<tag>.<ciphertext>`，与 issuer secret、论坛 token 同一套。**keyring 留在 env**：
  它是加密根，不是表单能填的值。
- 唯一读写口：`lib/github/app-config.ts`。读路径 `loadGithubConfig(db)` / `requireGithubConfig(db)`，
  写路径 `saveGithubAppConfig` / `addGithubAppKey` / `removeGithubAppKey` / `clearGithubAppConfig`，
  验证 `verifyGithubApp`（`GET /app`，同时证明 app id + 私钥是一对、且 slug 属于这个 App）。
- env 全部移除：`GITHUB_APP_ID`、`GITHUB_APP_SLUG`、`GITHUB_WEBHOOK_SECRET`、
  `GITHUB_APP_PRIVATE_KEYS`、`GITHUB_API_BASE_URL` 不再读取。存量部署在后台重新填一次即可，
  env 里的旧值被忽略（不静默回退——两个来源比一个来源更危险）。
- 进程内缓存 15 s，但**后台写入立刻失效**；缓存命中时按行 `updated_at` + key id 集合计算的
  签名比对，签名不变则复用同一个 `GithubConfig` 对象，从而让 `GithubAppClient` 的
  installation token 缓存跨请求存活（否则每 15 s 重新铸一次 token）。

## 放弃的方案

- **env 优先、数据库兜底（或反之）。** 两个来源意味着「改了没生效」永远要排查两处，且回退
  路径会被误用成灰度手段。一个来源，代价是升级后必须手工重填一次。
- **保留 `GITHUB_APP_PRIVATE_KEYS` 作为私钥来源，其余进库。** 私钥正是最需要轮换与校验的那一项，
  留在 env 等于把「拼字符串」这个缺陷留下。
- **把 keyring 也搬进库。** 加密根进库就是自欺：读库的人同时拿到密文与密钥。keyring 必须
  留在进程外（env / 密钥管理），这是这套加密唯一的真实边界。
- **用 `github_installations` 之类现成表扩展出配置列。** installation 是 GitHub 侧的对象，
  生命周期与配置完全不同，混在一起会让「删配置」和「删 installation」互相牵连。
- **不加密、靠数据库权限保护。** 商城自己的备份、`pg_dump`、只读副本都会把明文带走；issuer
  secret 已经加密，这里不加密是不一致的下限。

## 代价与重开条件

- **升级需要一次手工重填**（App ID、slug、webhook secret、私钥）。这是有意的：不写自动导入，
  因为 env 里的值是否仍与 GitHub 侧一致，只有运营知道。
- **读配置多一次查询**（缓存 15 s 内免）。webhook 每投递一次多一次单行 select；下载代理同理。
  实测可接受，因为两条路径本来就要读库（delivery 去重、asset 解析）。
- **web 与 worker 之间有最长 15 s 的窗口。** 后台改配置后，另一个进程最多 15 s 才看到新值。
  webhook 验签用的是新 secret，而 GitHub 侧一旦换了 secret 旧投递就失败——所以**轮换顺序是
  先在 GitHub 改 secret，再在后台改**，中间那段窗口的投递会 401。要缩短就把 TTL 调小，代价是
  每请求一次解密。
- **「配置坏了」与「没配置」必须区分。** 密文解不开（keyring 缺 kid）报
  `github_config_unreadable`，webhook 回 503 而不是当未配置静默放行；后台「配置自检」把
  `readError` 直接显示出来。这条不做成「降级成未配置」，否则一次 keyring 轮换失误会让
  webhook 静默失效。

重开条件：如果将来要支持**一个商城接多个 GitHub App**（例如按组织分租），单行表就是错的，
那时要重做成 `github_apps` 多行 + 产品/安装指向 App 的外键。v1 明确不做。
