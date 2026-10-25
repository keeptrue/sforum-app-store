# 2026-10-25 GitHub App 配置迁到后台（env → 数据库）

## 结果

GitHub App 的五项配置（`GITHUB_APP_ID` / `GITHUB_APP_SLUG` / `GITHUB_WEBHOOK_SECRET` /
`GITHUB_APP_PRIVATE_KEYS` / `GITHUB_API_BASE_URL`）从 env 搬进数据库，写入口只有后台
`/[adminPath]/settings/github`。起因是这些值本来就是**运行时配置**：换 App、轮换 webhook
secret、轮换签名私钥、临时指向 GHES 都是运营动作，而改 env 必须让 web 与 worker 一起重启，
滚动期间 webhook 会用旧 secret 验签，那段时间的投递全部 401。取舍见
`decisions/2026-10-25-github-app-config-in-console.md`。

同时补上了过去完全看不见的两件事：**这把私钥是不是这个 App 的**（`GET /app` 验证，顺带发现
slug 填错）、**现在到底是哪一把私钥在签名**（公钥指纹 + 「签名中」标记）。

验证：`bun test --parallel=1` → **458 pass / 0 fail / 43 files**（本轮新增 28 例：27 例在
`lib/github/app-config.test.ts`，1 例是下载代理对「配置读不出来」的 503）；`bunx tsc --noEmit` 干净；`bun --bun next build` 通过；
1633×810 与 390×844 渲染证据见 `tmp/github-app-{empty-,}1633{,-full,-keys}.png` 与
`tmp/github-app-390{,-full}.png`。

## 关键实现事实

- **单行表 + 多把私钥**：`github_app_config`（`id` 固定 `'default'`，`(true)` 表达式唯一索引
  兜住第二个 App）+ `github_app_private_keys`（`config_id` 级联删除、`app_key_id` 唯一）。
  `app_key_id` 是 JWT 头的 `kid`，`fingerprint` 是公钥 SPKI 的 SHA-256 —— GitHub 页面的 key id
  无法从文件推导，指纹才是能比对的那个，界面就用它做标签。
- **keyring 留在 env**：`STORE_SECRET_KEYS` 是加密根，搬进库等于把密文和密钥放在一起。
  webhook secret 与私钥都用它加密（`v1.<kid>.<iv>.<tag>.<ciphertext>`），与 issuer secret 同款。
- **唯一读写口 `lib/github/app-config.ts`**：`loadGithubConfig` / `requireGithubConfig`（读）、
  `saveGithubAppConfig` / `addGithubAppKey` / `removeGithubAppKey` / `clearGithubAppConfig`（写）、
  `verifyGithubApp`（`GET /app`）。其余模块一律不再碰 `getConfig().github`。
- **缓存按内容签名复用对象**：15 s TTL 只省掉「每请求一次读库 + 解密」；命中后还要比
  `updated_at` + key id 集合算出的签名，签名不变就返回**同一个** `GithubConfig` 对象。这一条是
  必须的：`download/upstream.ts` 与 `actions.ts` 按对象身份缓存 `GithubAppClient`，每 15 s 换对象
  就等于每 15 s 重新铸一次 installation token。后台写入后立刻 `invalidateGithubConfigCache()`。
- **「坏了」不等于「没配」**：密文解不开（keyring 缺 kid）抛 `GithubAppConfigError`
  `github_config_unreadable`，webhook 回 503、后台「配置自检」直接显示 `readError`。若降级成
  「未配置」，一次 keyring 轮换失误会让 webhook 静默失效。
- **worker 不再因未配置而拒绝启动**：`getConfig()` 仍校验 env（DB、keyring），App 只在 job 里
  按需读；未配置时打一行 warn。原来那种「没配 App 就起不来」会让升级期的队列积压无处消化。
- **验证一次答三问**：App ID 存在、私钥配对、slug 与 GitHub 上的一致。slug 不匹配报 `ok:false`
  但 HTTP 200（`GET /app` 成功了），消息里写明「安装链接会 404」。
- **`?` 轮换是「先加后删」**：最新一把签名（`GithubAppClient` 取 map 最后一个），最后一把不可删
  （409 `last_key`），因为签不出 JWT 时后台自己的「验证」也救不回来。
- **审计**：`admin.github_app.{created,updated,key_added,key_removed,removed,verified}`，
  `target_type='github_app'`（`AUDIT_TARGET_TYPES` 有编译期覆盖检查，漏加会直接类型报错）。
  details 只写「改了什么」，从不写 secret / 私钥 / 指纹以外的材料。
- **三个地址都只有一个推导源**：`webhookUrlFor` / `setupUrlFor` 在 `app-config.ts`，安装链接由
  slug 拼。后台第 1 节把它们显示出来给运营复制，避免「手打的那串」和「实际回的那串」漂移。
  **注意是 Setup URL，不是 Callback URL** —— 这是 GitHub App 设置页里两格不同的输入。

## 改动清单

**新增**：`service/src/lib/github/app-config.ts`(+test)、
`service/drizzle/0009_github_app_config.sql`、
`service/src/app/[adminPath]/(console)/settings/github/page.tsx`、
`service/src/components/admin/github-app-form.tsx`、
`service/src/app/api/admin/github-app/{route.ts,verify/route.ts,keys/route.ts,keys/[appKeyId]/route.ts}`、
`docs/github-app.md`、`knowledge/decisions/2026-10-25-github-app-config-in-console.md`、本交接。

**修改**：`service/src/db/schema.ts`（两张表）、`lib/config.ts`（删 `parseGithubConfig` 与
`StoreConfig.github`，`GithubConfig` 类型保留为纯声明）、`lib/github/client.ts`（`getApp()`）、
`lib/github/{jobs,actions}.ts`、`lib/products/binding.ts`、`lib/download/upstream.ts`、
`app/api/github/{webhook,setup,install/start}/route.ts`、`app/api/dashboard/github/repos/refresh/route.ts`、
`worker.ts`、`lib/admin/system.ts` + `components/admin/system-config-panel.tsx`（配置自检改为读库并
显示 app id / slug / 私钥数 / 上次验证）、`lib/admin/audit.ts` + `components/admin/audit-filter-form.tsx`
（`github_app` 目标类型）、`components/admin/nav-items.ts`、`lib/test-support/db.ts`（TRUNCATE 列表）、
`lib/github/actions.test.ts`、`lib/download/{resolve,issue}.test.ts`、`AGENTS.md`（GitHub App 与安全两节）、
`service/.env.example`、`service/README.md`、`docs/{deployment,README}.md`、`knowledge/{index,decisions/README}.md`。

## 未验证

- **真实 GitHub App 的 `GET /app`**：本地只跑了 stub（成功 / slug 不匹配 / 401 三条）。验证方式：
  在后台填一套真实凭据点「验证」，应看到 `已连通：<App 名>（<slug> · <owner>）`。
- **web 与 worker 之间的 15 s 窗口**：代码路径明确（各自进程内缓存），但没有做双进程实测。验证
  方式：起 web + worker，后台改 slug，观察 worker 侧日志里 `requireGithubConfig` 读到的值在 15 s 内
  变化。
- **真实 webhook 轮换**：文档写「先在 GitHub 改 secret，再在后台改，中间窗口内的投递会 401」。
  GitHub 是否会重投那几条、Redeliver 是否用新 secret 重签，本仓代码证明不了，**未验证**。
- **升级路径**：只在本地 dev 库跑过 `0009` 迁移（空表）。存量部署「env 里有旧值、库里没有行」的
  表现是「未配置」（503），需要运营在后台重填一次——这一步**未在真实部署上演练**。
- **渲染证据用的是 seeded 假数据**（假 App ID 与现场生成的私钥），「验证」按钮没有在浏览器里点过；
  验证链路的覆盖来自单测。复现方式：`service/tmp/visual-admin.ts create|delete`（临时管理员）与
  `service/tmp/visual-github-seed.ts seed|clear`（假配置），两个脚本都在 `tmp/`（不入库），跑完已把
  dev 库清回「无配置、无临时管理员、无 `admin.github_app.*` 审计行」。
