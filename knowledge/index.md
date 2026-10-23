# Knowledge Index

## 当前状态

**设计阶段，未批准实施。** 仓库只有骨架、约定与任务书，没有任何产品代码、依赖锁或迁移。
S0 之前不建 `service/` 与 `plugin/` 的真实工程文件。

## Latest Handoff

`sessions/2026-10-24-design-kickoff.md` —— 建仓 + 第一轮设计讨论的结论与待办。

## 当前计划

| 计划 | 状态 |
| --- | --- |
| `plans/2026-10-24-app-store-service.md` | **draft** —— 服务端与插件的完整设计；§10 是讨论台账，Q1–Q5 等待人工裁决 |

## 外部依赖（只读，不属于本仓）

| 依赖 | 位置 | 用途 |
| --- | --- | --- |
| SForum core 安装原语 | SForum `knowledge/plans/2026-10-24-app-store-core-install-primitive.md` §6.2 | 安装命令契约的唯一来源 |
| SForum OAuth2 提供方 | 仓 `github.com/zhuchunshu/sforum-oauth2-provider` | 登录端点、CSRF、userinfo、scope |
| Manifest V3 schema | SForum `apps/api/app/Support/ExtensionManifest/schemas/manifest-v3.schema.json` | 清单校验（来源钉法未定） |

## 关键约束速查

- 无注册、无密码、无动态客户端注册；账号键 `(issuer, sub)`。
- 全量 GitHub App；不存 PAT；不存包体；所有下载走签名短链。
- 安装只经 core 的 `extensions.install.*` 意图，只暂存。
- 一个 ZIP 只含一个扩展；`sforumVersion` 是 semver 约束。

详见 `../AGENTS.md` 与任务书 §2。

## 目录约定

- `plans/` —— 任务书。`draft` 期间不实施。
- `decisions/` —— 架构取舍；批准实施时创建首批两条。
- `sessions/` —— 热交接；旧的移入 `sessions/archive/YYYY-MM/`。
- `glossary.md` —— 术语，避免「产品/扩展/release」混用。
