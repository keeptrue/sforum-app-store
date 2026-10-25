# 2026-10-25 管理员密码重置命令（`admin:reset-password`）

## 这一轮做了什么

新增可脚本化的管理员密码重置命令，与原有交互式 `admin:password` 并存、共用同一条领域逻辑。

- `service/src/lib/admin/password-reset.ts` —— 领域层：`parseResetArgs`、`parseEnvText`、
  `generatePassword`、`findAdminByUsername`、`listAdminRows`、`resetAdminPassword`，
  错误统一 `AdminResetError`（`not_found` / `invalid_password` / `verify_failed`）。
- `service/scripts/admin-reset-password.ts` —— 薄 CLI：读 `.env.local`（`DATABASE_URL` 未导出时）、
  隐藏输入、stdin 读一行、输出与退出码。
- `service/src/lib/admin/password-reset.test.ts` —— 11 条：参数解析、env 解析、随机密码分类、
  重置事务（清锁定/失败次数/`must_change_password`、删会话、写审计、回读校验）、
  `--keep-sessions`、未知账号与不合格密码、大小写不敏感查找。
- 入口：根 `package.json` + `service/package.json` 的 `admin:reset-password`；根命令
  `cd service` 后转发参数，所以 `bun run admin:reset-password -- <username>` 在仓库根可用。
- 文档：`docs/deployment.md`「忘记管理员密码」补两种形态与退出码；`AGENTS.md` Commands 加一行。

## 为什么不是改原有脚本

原 `admin:password` 假定有 TTY、读两次输入。恢复场景经常没有终端（容器 `exec`、runbook、
自动化），而 `--generate` 还能避免密码经过任何人类或 shell 历史。两者共用
`resetAdminPassword`，行为（清锁定、删会话、审计 `admin.password.reset_cli`）只有一份实现。

## 关键实现取舍

- **stdout 契约**：`--generate` 不带 `--json` 时 stdout 只有密码一行，摘要走 stderr，
  这样 `PW=$(bun run admin:reset-password -- x --generate)` 干净可取值。
- **`--json` 才带密码**；交互式与 stdin 模式下 JSON 里 `password` 为 `undefined`（不落盘、不回显）。
- **写后回读校验**：`resetAdminPassword` 更新后重新 `select password_hash` 并 `verifyPassword`，
  失败抛 `verify_failed`。理由：一个存不进可验证哈希的重置，只有等操作员登录失败才会暴露。
- **会话默认全删**：shell 重置的前提是旧口令可能已在别人手里；`--keep-sessions` 显式保留并
  在摘要里告警。
- **`disabled` 账号照改但告警**：密码换了仍登不进去，摘要直接说出来。
- **env 自加载**：`parseEnvText` 只做最小解析（无展开、无多行），`process.env` 已有的键不覆盖；
  候选 `.env.local` / `service/.env.local` / `.env`。脚本里不依赖 `bun --env-file`，
  缺文件时不会在起进程前就失败。
- 密码生成 24 字符 / 60 符号表（约 141 bit），保证大小写与数字各至少一个，`randomInt` 避免取模偏差。

## 验证（本地，已跑）

- `bun test src/lib/admin/password-reset.test.ts` → 11 pass。
- 全量 `bun run test` → **469 pass / 44 files**、0 fail；`bunx tsc --noEmit` 干净。
- 端到端（dev 库 `127.0.0.1:15432/sforum_store`）：临时账号 `tmp.reset.check` 上跑
  `--generate --json`，用 `verifyPassword` 回验生成密码为真；库里 `failed_attempts=0`、
  `locked_until=null`、`must_change_password=false`、会话 0、`admin.password.reset_cli` 审计 1 条；
  `--password-stdin` 通过；无 TTY 无密码来源 → 退出 3；未知账号 → 退出 2；弱密码 → 退出 3；
  `--list` 只列 `root`。临时账号与它的审计行已删除，dev 库恢复原状。

## 未验证 / 下一步

- 未在 Node（`next start` 回退运行时）下跑这个脚本——它用 `node:fs` / `node:crypto`，
  理论上与运行时无关，但只实测过 Bun 1.4.2。
- 未做「重置后立刻登录一次」的真实浏览器验证（会话被删，等于要求重新登录；逻辑上有
  `loginAdmin` 覆盖）。
- `docs/deployment.md` 未加「在容器里 `docker exec` 运行」的示例；需要时按同一命令补一段。
