# service

商城服务端。**S0 之前这里只有约定，没有可运行代码。**

## 目标栈

Next.js（App Router）+ TypeScript + Tailwind；Bun 作包管理器与运行时（回退 Node 见 AGENTS.md
「运行时闸门」）；PostgreSQL 16 + Drizzle + pg-boss（独立 worker，同镜像）。

## 预期分层

```text
src/app/                 # 公开前台 / dashboard / moderation（路由壳）
src/app/api/v1/          # 公开 API + 插件 API
src/lib/oauth/           # provider 客户端（CSRF 握手、body 凭据、userinfo）
src/lib/github/          # App JWT、installation token 缓存、webhook 验签
src/lib/detection/       # ZIP → 清单 → buildinfo → sha256
src/lib/storage/         # 内容寻址图片存储（本地卷，预留 S3）
src/worker.ts            # pg-boss
drizzle/                 # schema + migrations
```

- 路由只做解码/编码；业务在领域服务；SQL 在 store。
- worker 与 HTTP 共享同一套领域服务，不复制逻辑。

## 环境变量（草案，待 Q1/Q2 裁决后定稿）

| 变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL |
| `STORE_PUBLIC_URL` | 对外基址，用于 OAuth 回调与下载短链 |
| `STORE_OAUTH_ISSUERS` | JSON 数组：每个 issuer 的端点与 `client_id/client_secret` |
| `STORE_BOOTSTRAP_ADMINS` | `issuer#sub` 列表，播种 admin |
| `STORE_SESSION_SECRET` | 会话签名 |
| `STORE_TOKEN_KEY` | 论坛 token 的 AES-256-GCM 密钥（预留 `kid` 轮换） |
| `STORE_DOWNLOAD_SECRET` | 下载短链签名 |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEYS` / `GITHUB_WEBHOOK_SECRET` | GitHub App |

缺关键变量启动即失败，不降级成「部分功能可用」。

## 不该做的事

- 不接注册、不存密码、不做动态客户端注册。
- 不存 ZIP、不缓存上游包体、不把 GitHub 直链写进任何响应。
- 不代劳 SForum 的启用/信任。
