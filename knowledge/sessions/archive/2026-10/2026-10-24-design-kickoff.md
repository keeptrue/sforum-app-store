# 2026-10-24 Session Handoff — 建仓与第一轮设计

## Changed

- 新建仓库 `~/Code/github/sforum-app-store`（`main`，MIT），建立 `service/`、`plugin/`、
  `contracts/`、`docs/`、`knowledge/` 骨架；**没有任何工程代码、依赖或迁移**。
- 写入 `AGENTS.md`（仓库约定）、根 `README.md`、`.gitignore` / `.gitattributes` /
  `.editorconfig`。
- 把服务端计划从 SForum 迁入 `knowledge/plans/2026-10-24-app-store-service.md`，作为权威副本：
  补入四条已核实事实、修正 monorepo 那处自相矛盾的校验规则、新增 §10 讨论台账。

## Decisions

- 权威副本设在本仓；SForum 侧按流程保留原样，定稿后由人工决定是否改成指针。
- 许可证 MIT（与 `sforum-oauth2-provider` 一致）。
- 计划状态维持 `draft`；批准前不动实现。

## 已核实（本轮，写入计划 §2.1）

- 一个 ZIP 只含一个扩展（`ReadArchive` 返回单个 Manifest）。
- `sforumVersion` 是 Masterminds semver 约束，schema 只校验非空。
- provider 的 secret 轮换是单哈希覆盖，但 refresh token 绑 `client_id`，轮换不踢已登录用户。
- 客户端凭据只能走请求体，`Authorization` 头到不了插件路由。
- 未验证：宿主是否向插件暴露自身版本号（影响目录的 `?sforum=` 兼容性过滤）。

## Next

1. 新会话开场先读 `AGENTS.md` → `knowledge/index.md` → 计划 §10。
2. 用提问工具逐组裁决 Q1–Q5（身份拓扑 / GitHub App 边界 / 数据建模 / 版本语义 / 下载 token）。
3. Q1–Q5 定稿后，一次性改计划 §5.2、§5.3、§5.4、§5.6 与 `plans/README.md` 对应行，状态仍为
   `draft`。
4. 再进下一轮：产品页信息架构、插件页状态机、运维（Bun 回退判定、App 注册 10 分钟、备份/迁移）。
5. 全部收敛后由人工说「批准」，才把状态改为 `ready` 并开 S0。

## Open Questions

- Q1 官方实例是否只接受官方论坛账号（倾向：是）。
- Q2 产品状态是否拆 `status` + `upstream_state` 双轴（倾向：是）。
- Q3 release 是否拆「仓库标签 → 扩展版本 → 资产」三层（倾向：是）。
- Q4 tag 与 manifest 版本不一致是否一律 `needs_attention`（倾向：单扩展组是）。
- Q5 下载 token 是否放弃「单次性」换 worker 重试可用（倾向：是，TTL 30 分钟 + 绑定 sha256）。
