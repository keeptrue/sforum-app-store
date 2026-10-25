# 身份与分发口径

Status: accepted
Date: 2026-10-24

## 背景

商城要同时服务官方实例与自部署实例，但不能做注册、不能存 PAT、不能让下载链与安装意图的
时间窗打架。Q1/Q5/Q6 的裁决需要一个可执行的单一来源，避免数据模型与分发行为各写一套。

## 决定

### 身份

- 一个部署同一时刻只有一个 active issuer；官方实例 = 官方论坛，自部署 = 自己论坛。
- 账号键 `(issuer_key, sub)`。`issuer_key` 是运营方指定的稳定标识（`official` / `self`），
  **永不复用、永不改名**；URL 只是配置，换域名不改账号归属。
- `oauth_issuers` 是真相表；首条由 `STORE_BOOTSTRAP_ISSUER` 种入，之后 env 只做种子。
  secret 用 AES-256-GCM 加密，`kid` 轮换；轮换后要同步更新或移除 env 种子。
- issuer 下线 → 账号派生 `orphaned` → 商品进「归属失效」队列，人工转移或下架。转移证据 =
  目标账号已有 App installation 覆盖该仓库；不做自动 N 天认领。

### 分发

- 所有下载走商城签名代理；token 绑定 asset id + sha256 + exp，TTL 30 分钟，可重复取用。
  **不承诺单次**：SForum worker 重试无法重新签名，且安装意图 15 分钟才过期。
- 下发时复核：资产存在、未 yank、摘要一致、版本/产品 published、上游非 disconnected。
  **不要求「当前最新版本」**，否则发布与安装会互斥失败。
- 商城不存包体；ZIP 只落临时文件，检测完即删。

### 兼容性

- 宿主通过 `host.api` `Ping` 暴露 `coreVersion`（`CoreCompatibilityVersion()`）与
  `buildVersion`（`Get().Version`）；商城按 Masterminds 约束求值，不做等值比较。
- 缺版本或非法值 → `compatibility=unknown`，不过滤；dev 构建标「按开发版估算」。core 的
  `incompatible` 仍是最终裁判。

## 放弃的方案

- 官方多 issuer 白名单 / 开放联邦：运维与身份信任成本高，抢注防线失效。
- 短 TTL + 单次 token + 改安装契约：core 要认识商城，且重试仍拿不到新 URL。
- 服务端 nonce 表：v1 多一张表与 GC，收益仅是逐 token 撤销，泄露检测仍靠外部告警。

## 代价与重开条件

- 同一自然人若换论坛，会有两个账号，商品不合并；这是单 issuer 拓扑的已知代价。
- 30 分钟 token 可被转发复用；靠 yank/断开立即 410 与限流兜。
- 若 SForum worker 将来支持回源换签名 URL，可重开「单次 token」。

## 落地（2026-10-25）

上面的「一个部署同一时刻只有一个 active issuer」原本只是口径，代码没执行：后台能建任意多个
`active`，而登录侧要求调用方自带 `?issuer=`，且没有选择页、前台也不渲染 `?error=`，多 issuer
等于把登录打死。本轮把它变成三层不变量：

- **数据库**：`oauth_issuers_single_active_idx`（部分唯一索引，`WHERE status = 'active'`，
  迁移 `0007_small_mathemanic.sql`）。迁移前若库里已有多行 active 会**报错退出**并给出处理指令，
  不静默 retire——那会改写账号归属历史。
- **服务层**：`lib/admin/issuers.ts` 的 `assertNoOtherActiveIssuer`（建/重新启用两条路径），
  并把并发下的 `23505` 转成同一个 409 `issuer_active_exists`。
- **后台 UI**：已有 active 时「新增 issuer」禁用；active 行标「登录来源」；停用确认写明后果。

`?issuer=` 降为兼容参数：0 个 → `/?error=no_issuer`；1 个 → 直接用；>1 个（迁移遗留）→
`/?error=multiple_issuers`。三种错误码在前台都有可读提示（`components/storefront/issuer-notice.tsx`），
不再静默落回目录页。

回调地址由 `lib/oauth/redirect.ts#sforumCallbackUrl` 单一推导，后台展示与登录请求共用同一串，
避免「复制的那串」和「实际发送的那串」漂移。接入步骤见 `docs/oauth-setup.md`。

**重开条件**（若将来真要接多个论坛）：先补登录选择页与跨论坛归属/审核语义，再撤索引；不要只撤
索引或只加 `?issuer=` 参数。
