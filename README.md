# sforum-app-store

SForum 应用商城：一个独立服务端 + 一个 SForum 插件，同仓两产物。

Status: **实现阶段（S0–S6 完成）**。`service/` 已有 DB 驱动的目录与详情、公开 `/api/v1`、
签名下载代理、产品 CRUD 与内容寻址图片、OAuth2 登录与会话、Postgres 迁移、GitHub App 客户端、
webhook 验签/幂等、pg-boss worker 与 release 同步/检测。审核台与插件均已落地。
任务书 `knowledge/plans/2026-10-24-app-store-service.md` 状态为 `active`。

## 快速开始（S0/S1）

```bash
bun install
bun run dev          # http://127.0.0.1:4000
bun run build        # Bun 运行时闸门
bun run test         # unit + Postgres 集成
bun run contract:generate
bun run db:migrate   # 需要 service/.env.local
bun run seed:dev     # 本地预览数据（幂等；生产不用）
bun run worker       # GitHub webhook / release 同步
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
5. **安装只经 SForum core 的 `extensions.install.*` 意图 + worker**，商城只暂存，永不代劳启用或信任。

## 先读什么

`AGENTS.md`（仓库约定）→ `knowledge/index.md`（当前状态）→ `knowledge/plans/`（任务书）。

## 许可

MIT，见 `LICENSE`。
