# sforum-app-store

SForum 应用商城：一个独立服务端 + 一个 SForum 插件，同仓两产物。

Status: **实现阶段（S0–S6 完成）**。`service/` 已有 DB 驱动的目录与详情、公开 `/api/v1`、
签名下载代理、产品 CRUD 与内容寻址图片、OAuth2 登录与会话、Postgres 迁移、GitHub App 客户端、
webhook 验签/幂等、pg-boss worker 与 release 同步/检测。审核台与插件均已落地。
任务书 `knowledge/plans/2026-10-24-app-store-service.md` 状态为 `active`。

## Docker 一键部署（推荐）

前置只有 `docker` 与 `docker compose` v2 插件。web、worker、迁移与一个内置 PostgreSQL 17
由同一份 `docker-compose.yml` 拉起，宿主不需要 Bun / Node / Postgres。

```bash
git clone https://github.com/keeptrue/sforum-app-store.git
cd sforum-app-store
bash scripts/docker/bootstrap.sh
```

脚本按顺序做六件事，任一步失败都以非零码退出：生成 `.env`（`chmod 600`；已存在则复用，
不覆盖任何密钥）→ 校验必填项 → 端口预检 → 拉镜像 → `docker compose up -d` → 等 `web`
healthy 并打印 `/api/health`。

迁移是自动的：compose 里的 `migrate` 一次性容器先跑 `bun src/db/migrate.ts`，`web` /
`worker` 用 `depends_on: service_completed_successfully` 等它退出 0；迁移失败时 web 不会带着
旧 schema 起来。每次 `docker compose up -d` 都会重跑一次（compose 会重新 start 已退出的
容器），drizzle 迁移幂等，日志里出现多次 `migrations applied` 是正常的。手工部署不走这条
路：`bun run start` / `bun run dev` 都不迁移，必须自己先跑 `bun run db:migrate`。

镜像默认 `ghcr.io/keeptrue/sforum-app-store:edge`（跟随 `main`；要可复现就钉 semver tag）。
包可见性跟随仓库：当前仓库私有，GHCR 包默认也私有，首次拉取前先登录（token 需要
`read:packages`）：

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
```

不用 GHCR 就从源码构建：`docker build -t sforum-app-store:local .`，再
`STORE_IMAGE=sforum-app-store:local bash scripts/docker/bootstrap.sh`。

### 首次初始化：创建管理员

`bootstrap.sh` 首次生成 `.env` 时随机出 `STORE_ADMIN_SETUP_TOKEN` 并打印一次；错过就
`grep STORE_ADMIN_SETUP_TOKEN .env`。打开默认地址：

```
http://127.0.0.1:4000/admin
```

库里还没有管理员时，`/admin` 会 307 跳到 `/admin/setup`，填 token、用户名、密码即可；
注册成功后这个入口永久关闭（`/admin/setup` 变 404），`/admin` 改为跳 `/admin/login`。
之后把 `.env` 里 `STORE_ADMIN_SETUP_TOKEN` 那一行删掉，`docker compose up -d`。
**没配 token 时 `/admin/setup` 只显示「注册入口未开启」，不会出现可提交的表单。**

商城没有面向普通用户的注册：论坛用户第一次 OAuth2 登录时自动建账号，管理员是另一条
本地身份线（`admin_accounts`），两者不互通。

### 挂反向代理 / 对外服务

`.env` 的 `STORE_PUBLIC_URL` 必须是访客地址栏里的那个地址（生产只接受 `https`，http 仅限
`127.0.0.1` / `localhost` / `::1`）：

```bash
$EDITOR .env      # STORE_PUBLIC_URL=https://store.example.com
docker compose up -d
PORT="$(sed -n 's/^STORE_HTTP_PORT=//p' .env | tail -1)"; PORT="${PORT:-4000}"
curl -s "http://127.0.0.1:${PORT}/api/health" | grep -o '"publicUrl":"[^"]*"'
```

反代转发到 `127.0.0.1:<STORE_HTTP_PORT>`（默认 `4000`），保留原始 Host 与
`X-Forwarded-Proto`，不要改写路径前缀——`/admin` 的跳转是相对路径。OAuth 回调、下载短链
与同源校验都从生效地址推导；地址不一致的症状见
[`docs/deployment.md` §2](docs/deployment.md#反向代理与隧道cloudflare-tunnel-等)。

后台路径由 `STORE_ADMIN_PATH` 决定（默认 `admin`，单段；`/api`、`/dashboard`、`/moderation`、
`/p`、`/_next` 是保留字）。改完重启即生效，不用重建镜像；改成别的段后 `/admin` 就是 404。

### 日常命令

| 命令 | 用途 |
| --- | --- |
| `bash scripts/docker/bootstrap.sh status` | 看容器状态 |
| `bash scripts/docker/bootstrap.sh logs` | 跟日志 |
| `bash scripts/docker/bootstrap.sh down` | 停机，保留 `pgdata` / `assets` 卷 |
| `docker compose pull && docker compose up -d` | 升级（先改 `.env` 的 `STORE_IMAGE`） |

升级前备份数据库与资产卷；忘记管理员密码：
`docker compose exec web bun scripts/admin-reset-password.ts -- <username> --generate`。
端口、卷、密钥、备份恢复与常见失败的完整清单见
[`docs/deployment.md` §3](docs/deployment.md#3-docker-compose-一键部署)。

## 快速开始（S0/S1）

```bash
bun install
bun run dev          # web + worker，http://127.0.0.1:4000
bun run dev:stop     # 停 web + worker，清掉 Next dev 锁（--force 强杀）
bun run build        # Bun 运行时闸门
bun run start        # web + worker（生产）
bun run start:web    # 只起 web（多副本 / 排障）
bun run test         # unit + Postgres 集成
bun run contract:generate
bun run db:migrate   # 需要 service/.env.local
bun run seed:dev     # 本地预览数据（幂等；生产不用）
bun run worker       # 只起 worker（GitHub webhook / release 同步）
curl http://127.0.0.1:4000/api/health
```

目录与产品详情读 Postgres；空库时目录显示空状态，不造假数据。

## 两个产物

| 目录 | 产物 | 说明 |
| --- | --- | --- |
| `service/` | 商城服务端 | Next.js + Bun + PostgreSQL。公开目录、开发者门户、审核后台、GitHub 同步、签名下载代理 |
| `plugin/` | SForum 扩展 `sforum.store` | Go 后端 + 预构建 Vue 管理页。站内浏览、解析、安装交接 |
| `contracts/` | 共享契约 | `store-api.yaml`；生成 TS 类型与 Go client，避免跨产物漂移 |

## 硬边界（改动前先读）

1. **登录只来自 SForum OAuth2 提供方**，商城不提供注册、不存密码、不做动态客户端注册。
2. **全量 GitHub App**，不存 PAT；私有 release 只经 installation token 读取。
3. **不存包体**：ZIP 只在临时文件里过一遍，检测完即删。
4. **所有下载走商城签名短链**，不暴露 GitHub 原始地址；免费/私有都在同一条信任链上。
5. **安装与启用都只经 SForum core 的宿主动作**（`bridge.installExtension` / `bridge.installAndEnableExtension`）：
   商城把包与身份交给宿主，启用、信任、激活由宿主按自己的规则决定，商城永不代劳。
   插件清单声明了 `extension.install.enable`，因此需要带这个动作的 core（旧 core 会拒绝整份清单）。

## 先读什么

`AGENTS.md`（仓库约定）→ `knowledge/index.md`（当前状态）→ `knowledge/plans/`（任务书）。

## 许可

MIT，见 `LICENSE`。
