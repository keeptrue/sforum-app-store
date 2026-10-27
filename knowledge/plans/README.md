# Plans

只放 `draft`、`ready`、`active`、`blocked`、`blueprint` 状态的任务书。完成/取消/被取代的计划
移入 `archive/YYYY-MM/`。

## Status Vocabulary

| Status | 含义 |
| --- | --- |
| `draft` | 设计评审中；**人工批准前不实施** |
| `ready` | 已批准清单，可以开工 |
| `active` | 进行中 |
| `blocked` | 依赖未清，暂停 |
| `blueprint` | 长期产品方向，不是单个迭代 |
| `completed` | 已完成，待归档 |
| `cancelled` | 明确停止 |
| `superseded` | 被其他来源取代 |

## Current Plans

| Plan | Status |
| --- | --- |
| `2026-10-27-download-auth-gate.md` | **ready（2026-10-27 批准；新对话开工）** -- 下载签发前必须登录：商城 `/connect/{id}` 授权页 + 插件后端轮询、后端持有 30 天令牌并写入宿主加密 secret 设置、core 新增 `SecretService.Put/Clear`（只写声明的 secret 字段）、`download_auth_mode` 默认 `anonymous`；单 agent 执行顺序见 §10；契约 `contracts/store-api.yaml` |
| `2026-10-25-github-only-products.md` | **active（2026-10-25 批准并实施）** -- 产品身份单源化：关闭手动创建（`POST /api/dashboard/products` → 410）、图标改为 GitHub 社交预览（服务端抓取 + 内容寻址）、截图上传与 `product_screenshots` 表删除、介绍改为仓库 README（markdown-it + sanitize-html，HTML 为唯一对外表示）、名称由扩展清单驱动、摘要仍手写但可从 README 填充。契约 `ProductDetail.readme`。决策记录 `decisions/2026-10-25-github-only-product-identity.md` |
| `2026-10-25-admin-console.md` | **active（2026-10-25 批准）** -- 管理员本地身份（`admin_accounts` + `admin_sessions`，scrypt 密码，与论坛身份彻底隔离）+ 可配置后台路径（`STORE_ADMIN_PATH`，默认 `/admin`，动态段实现）+ 一次性 setup token 注册首个管理员 + OAuth2 issuer 全部后台可配（`STORE_BOOTSTRAP_ISSUER` 废弃）+ 六个模块（账号与角色、审计日志、全局产品、issuer 与 GitHub、系统健康、发布策略只读）。决策记录 `decisions/2026-10-25-admin-local-identity.md` |
| `2026-10-24-app-store-service.md` | **active（S0–S6 完成 + 2026-10-24 收尾轮，待人工确认）** -- 服务端（Next.js + Bun + PostgreSQL：OAuth2 登录、GitHub App、自动检测、签名下载代理、公开前台/开发者门户/审核台、四通道限流、认证审计）与插件 `sforum.store`（目录/详情/安装交接、zh-CN + en-US 管理页）。Q1–Q6 已裁决（§10.2）；S3/S4/S5/S6 细则见 §7.3–§7.6；收尾轮修掉 provider 契约漂移（JSON 请求体 + camelCase userinfo）并关闭 N+1 / Actions 提示 / en-US 三项遗留（§7.1 复核、§7.4 第 25 条、§7.5 补充）；仍未验证：真实登录、浏览器点击安装、真实 GitHub App（§11 第 6/8/10 条） |

改状态时同步改本表；不要把已关闭的计划留在默认目录。
