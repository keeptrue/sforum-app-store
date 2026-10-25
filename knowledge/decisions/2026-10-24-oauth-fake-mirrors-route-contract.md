# OAuth 高保真 fake 必须复刻插件路由契约，不只是 OAuth 语义

Status: accepted
Date: 2026-10-24

## 背景

S1 起登录链路一直用 `service/test/fake-provider.ts` 验收（任务书 §7.1 明确选了「高保真 fake」
而不是真实论坛）。2026-10-24 本轮第一次对**真实** `sforum-oauth2-provider`（本机 8080 上运行
的实例）做只读探针，用我们自己的 `SforumOAuthClient` 打真实端点，发现两处漂移——两处都是
fake 当初按「OAuth 语义」实现、而不是按「插件路由契约」实现造成的：

1. **编码**：我们的换 token / refresh / revoke 发的是
   `application/x-www-form-urlencoded`。provider 的路由声明是 `application/json` 且
   `additionalProperties: false`，宿主在 handler 之前按 schema 校验，于是真实响应是
   **422 `extensions.route_schema_invalid`**（不是 400 `invalid_request`）。fake 因为自己解析
   form，一路绿。
2. **字段名**：真实 userinfo 返回 camelCase（`displayName` / `avatar` / `emailVerified`，
   由 `schemas/userinfo.response.json` 的 `additionalProperties: false` 固定），我们读的是
   `name` / `avatar_url` / `email_verified`。fake 直接回显我们自己的形状，于是显示名与头像在
   真实环境下会静默变成 `undefined`。

后果的严重性在于：这两处都不是边角功能，**换 token 是登录的唯一路径**。若没有这次复核，
接真实论坛的第一次登录就会失败，而所有测试都是绿的。

## 决定

1. fake provider 的**请求**侧按 provider 的 `x-sforum-request-schema` 校验：只收
   `application/json`、拒绝未声明字段、执行 schema 里的 `minLength` 与 `enum`；不符合就回
   422 + `{"data":{"reason":"extensions.route_schema_invalid"}}`，与宿主一致。
2. fake provider 的**响应**侧用真实字段名（camelCase、`avatar`、`emailVerified`），错误体按
   真实形状分叉：`token` 用 `error_description`，`revoke` 用 `errorDescription` + `revoked`。
3. 客户端解析对真实字段优先、snake_case 作为兜底（`firstString`/`firstBoolean`），这样换
   provider 版本不会把字段读丢。
4. 今后每拿到一条对真实 provider 的只读观察，先补 fake，再改客户端——顺序不能反。

## 放弃的方案

- **只模仿语义**（S1 的做法）：编码、字段名、错误体这些传输层契约漂移会一路绿到生产。
- **CI 依赖真实论坛**：需要 client_secret 与一个已登录的论坛用户会话，不可复现、不可并行。
- **两个 fake（严格 / 宽松）**：多一份实现，谁在用哪一份说不清；只保留严格的那一份。

## 代价与重开条件

- fake 会随 provider 契约演化而需要维护；schema 里新增字段时 fake 有滞后风险（已通过
  `additionalProperties:false` 的显式白名单把滞后变成测试失败而不是静默放过）。
- 若 provider 提供官方的契约 fixture / conformance 套件，用它的 fixtures 替换手写校验逻辑；
  届时本决策的第 1 条可退役。
