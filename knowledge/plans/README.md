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
| `2026-10-24-app-store-service.md` | **draft（讨论中，未批准实施）** -- 服务端（Next.js + Bun + PostgreSQL：OAuth2 登录、GitHub App、自动检测、签名下载代理、公开前台/开发者门户/审核）与插件 `sforum.store`（目录/详情/安装交接）。§10 是讨论台账：A1–A9 为已识别缺口，Q1–Q5 待裁决，Q6–Q8 为下一轮 |

改状态时同步改本表；不要把已关闭的计划留在默认目录。
