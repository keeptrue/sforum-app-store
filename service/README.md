# service

商城服务端。**S4 完成：DB 驱动的目录/详情、公开 `/api/v1`、签名下载代理、产品 CRUD 与图片、
审核流（首个产品人工、后续按策略自动）、开发者门户与审核台、OAuth2 登录/会话、
GitHub App、webhook/worker、release 同步与检测。**

## 目标栈

Next.js（App Router）+ TypeScript + Tailwind；Bun 作包管理器与运行时（回退 Node 见 AGENTS.md
「运行时闸门」）；PostgreSQL 16 + Drizzle + pg-boss（独立 worker，同镜像）。

## S4 路由

- `GET /api/moderation/queue`、`GET /api/moderation/products/{id}` —— 审核队列与详情
  （`moderator|admin`，匿名 401、无角色 403）。
- `POST /api/moderation/products/{id}/{approve,reject,delist}`、
  `POST /api/moderation/versions/{id}/{approve,reject}` —— 状态推进，拒绝/下架必须带理由；
  状态变更 + `moderation_events` + `audit_log` 同事务。
- `POST /api/dashboard/products/{id}/submit` —— 提交审核（draft/rejected/delisted →
  pending_review）。
- `POST /api/dashboard/versions/{id}/yank` —— 撤回已发布版本（立即影响下载）。
- 页面：`/dashboard`、`/dashboard/products/[id]`、`/moderation`。

## S3 路由

- `GET /api/v1/catalog` / `GET /api/v1/products/{slug}` / `.../releases` / `.../releases/{version}`
  —— 公开读模型，ETag + `public, max-age=60, stale-while-revalidate=300`；只出 published。
- `POST /api/v1/download-urls` —— 匿名签发 `{url, sha256, size, expiresAt}`（TTL 30 分钟）。
- `GET /api/v1/download/{token}` —— 验签 + 五项复核后流式转发；失败 410 稳定错误码。
- `GET /api/v1/products/{slug}/download/{os}/{arch}` —— 302 到同一签发结果（浏览器入口）。
- `GET/POST /api/dashboard/products`、`GET/PATCH/DELETE /api/dashboard/products/{id}`、
  `POST .../icon`、`POST .../screenshots`、`PUT .../screenshots/order`、
  `DELETE .../screenshots/{id}` —— owner-only dashboard API，越权 404。
- `GET /api/assets/{sha256}` —— 内容寻址图片，`immutable` 长缓存。

## S1 路由

- `GET /api/auth/sforum/start` —— 生成 state + PKCE，写短时签名 Cookie，307 到论坛 authorize。
- `GET /api/auth/sforum/callback` —— 验 state，走 CSRF 握手换 token，拉 userinfo，建会话。
- `GET /api/auth/session` —— 返回账号与角色；未登录 401。
- `POST /api/auth/refresh` —— 同源校验，轮换 refresh token；失败标 `reauth_required`。
- `POST /api/auth/logout` —— revoke 论坛 token，删会话，清 Cookie。

## 预期分层

```text
src/app/                 # 公开前台 / dashboard / moderation（路由壳）
src/app/api/v1/          # 公开 API + 插件 API
src/lib/oauth/           # provider 客户端（CSRF 握手、body 凭据、userinfo）
src/lib/github/          # App JWT、installation token 缓存、webhook 验签
src/lib/detection/       # ZIP → 清单 → buildinfo → sha256
src/lib/catalog/         # 目录读模型：可见性、兼容求值、keyset 分页、ETag
src/lib/download/        # 签名 token、签发、下载复核、上游流式转发
src/lib/products/        # 产品 CRUD 规则 + 分类法 + 物化最新版
src/lib/moderation/      # 审核策略、事件/审计写入、队列与状态推进
src/lib/storage/         # 图片准入与内容寻址本地存储（预留对象存储适配器）
src/worker.ts            # pg-boss
drizzle/                 # schema + migrations
```

- 路由只做解码/编码；业务在领域服务；SQL 在 store。
- worker 与 HTTP 共享同一套领域服务，不复制逻辑。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL |
| `STORE_PUBLIC_URL` | 对外基址的**种子**：OAuth 回调、错误跳转、下载短链、GitHub webhook 都由它派生，但后台「系统设置」里保存过的值优先，保存即生效 |
| `STORE_SECRET_KEYS` | `kid:key` 列表，AES-256-GCM 加密 issuer secret、论坛 token 与 GitHub App 的 webhook secret / 私钥 |
| `STORE_SESSION_SECRET` | 会话签名 |
| `STORE_DOWNLOAD_SECRET` | 下载短链签名（≥32 字符） |
| `STORE_ASSET_DIR` | 内容寻址图片存储根，默认 `service/.data/assets` |
| `STORE_BUILD_VERSION` / `STORE_BUILD_COMMIT` | `/api/health` 与页脚显示 |

缺关键变量启动即失败，不降级成「部分功能可用」。`STORE_PUBLIC_URL` 仍是启动必填，但它只是种子：
后台「系统设置」（`/<STORE_ADMIN_PATH>/settings/general`）存过值之后以 `store_settings` 为准，
`bun run settings:public-url -- --clear` 或页面上的「恢复默认」回落到种子。OAuth2 issuer 与管理员账号都不再从 env 种入：
首个管理员凭 `STORE_ADMIN_SETUP_TOKEN` 注册，issuer 在后台「OAuth2 配置」里建（见 `docs/oauth-setup.md`）。

GitHub App 也不从 env 读：App ID、slug、API base URL、webhook secret 与私钥都在后台
「GitHub App」（`/<STORE_ADMIN_PATH>/settings/github`）里填，加密后存进 `github_app_config` +
`github_app_private_keys`，`STORE_SECRET_KEYS` 就是加密它们的 keyring。`GITHUB_APP_ID` /
`GITHUB_APP_SLUG` / `GITHUB_WEBHOOK_SECRET` / `GITHUB_APP_PRIVATE_KEYS` / `GITHUB_API_BASE_URL`
已移除且不再读取。没配 App 不阻止启动：webhook、安装流程、仓库同步与下载代理返回 503
`github_not_configured`，worker 照常起。见 `docs/github-app.md`。

## 不该做的事

- 不接注册、不存密码、不做动态客户端注册。
- 不存 ZIP、不缓存上游包体、不把 GitHub 直链写进任何响应。
- 不代劳 SForum 的启用/信任。
