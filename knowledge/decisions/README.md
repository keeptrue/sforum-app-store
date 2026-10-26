# Decisions

架构与产品的**取舍记录**。只写「为什么选它、放弃了什么、什么条件下重开」，不写教程。

## 何时必须写

- 选了某个第三方库/服务，或决定自己写基础设施。
- 引入新的数据域、状态机、跨产物契约。
- 触碰信任边界：谁能触发安装、谁能改 issuer、谁能看私钥。
- 推翻本仓 AGENTS.md 里的一条约定。

## 命名

`YYYY-MM-DD-<kebab-topic>.md`，例如 `2026-10-24-app-store-out-of-tree.md`。

## 结构

```md
# <标题>

Status: proposed | accepted | superseded
Date: YYYY-MM-DD

## 背景
## 决定
## 放弃的方案
## 代价与重开条件
```

## 已创建（2026-10-24 批准实施）

- `2026-10-24-app-store-out-of-tree.md` —— 商城为什么在 SForum 之外，边界在哪。
- `2026-10-24-app-store-identity-and-distribution.md` —— issuer 拓扑、下载分发与宿主版本口径。
- `2026-10-24-ui-stack.md` —— shadcn/ui Nova、Lucide、Motion、分栏、拖拽、Zustand 与依赖纪律。
- `2026-10-24-s2-github-and-zip.md` —— 薄 GitHub 客户端、installation token 缓存、yauzl/yazl 与检测顺序。
- `2026-10-24-s3-catalog-assets-and-storage.md` —— semver 约束求值（含 Masterminds 偏差）、
  file-type/image-size 判据顺序与「不引 sharp」、本地内容寻址存储、目录 ETag 与 keyset 分页。
- `2026-10-24-s4-review-flow.md` —— 双轴审核状态、自动发布的不变量、重新进审的边界、
  能力不分风险等级（v1）、单审员与同事务审计。
- `2026-10-24-s5-plugin-admin-page.md` —— 手写 ESM 而非 Vue/SDK、插件后端代理而非跨域直连、
  不声明宿主版本、v1 不做更新检查、进程内 ETag 缓存。
- `2026-10-25-admin-local-identity.md` —— 管理员是商城本地账号，与论坛身份互不授予；首个管理员
  凭一次性 setup token 注册。
- `2026-10-25-github-repo-binding.md` —— sync 不再建产品/补 `repo_id`/跨仓库写版本；未认领的
  扩展 ID 进 `repo_claims`；绑定强度分 `installation` 与 `github_identity` 两级。
- `2026-10-25-github-app-config-in-console.md` —— GitHub App 配置离开 env 进库（单行
  `github_app_config` + 多把 `github_app_private_keys`），后台是唯一写入口，keyring 仍在 env；
  「配置坏了」与「没配置」分开表达。
- `2026-10-25-runtime-store-settings.md` —— 对外地址、下载有效期与六个限流通道进单行
  `store_settings`，env 只作种子；15 秒快照 + 保存即失效；防自锁靠同源双判据、两个确认闸门与
  CLI；cookie 形状跟随生效地址（协议切换全员重登）。
- `2026-10-25-github-app-manifest-flow.md` —— GitHub App 用 Manifest 一键注册（GitHub.com）：
  权限/事件/地址写进代码，`id`/`slug`/`pem`/`webhook_secret` 由 GitHub 交回；`public: true`
  是硬要求；替换语义（删行级联删旧私钥）；state 绑管理员会话，因为 conversions 端点不认证。
  手动表单保留给 GHES 与接管已有 App。
- `2026-10-24-oauth-fake-mirrors-route-contract.md` —— OAuth 高保真 fake 必须复刻插件路由的
  request/response 契约（JSON、`additionalProperties:false`、camelCase 字段），只模仿语义会让
  表单编码这类缺陷一路绿到生产。
- `2026-10-25-manifest-contract-alignment.md` —— 清单结构以宿主 JSON Schema 为唯一权威
  （vendor + lock + 双跑夹具）；只补语义差量与归档边界，不搬 V3 校验器；清单元数据落库展示但
  不改变「产品身份只来自 GitHub」。
- `2026-10-25-readme-rendering.md` —— 标题用 clamp 而非整体下移（`###` 不能再落到正文大小）；
  高亮选 highlight.js 而非 shiki，因为 sanitize 必须继续禁内联 `style`；表格由渲染器包滚动容器
  （`display:block` 会让 `thead`/`tbody` 各自算列宽）；交互在客户端注入、不回写存量 HTML；
  目录取自 DOM，不进契约与数据库。
- `2026-10-25-download-redirect-mode.md` —— 下载分发加 `STORE_DOWNLOAD_MODE=proxy|redirect`：公开
  仓库可 302 到 GitHub 已签好的对象地址（带宽离机），私有仓库永远代理；复核仍签发这一跳生效，
  但已发出的 302 撤不回；默认仍是全量代理。
- `2026-10-26-catalog-card-dialog.md` —— 目录改卡片网格（列数走容器查询，不用视口断点）；详情改挂
  `body` 的固定高三 Tab 弹窗（`container-type` 会成为 fixed 包含块）；安装语义与「已暂存」不变；
  更新说明仍是纯文本。
- `2026-10-26-release-notes-markdown.md` —— 更新说明改由服务端渲染（`notesHtml` 与 `notes`
  同时下发，复用 README 的渲染器与白名单）；notes 不挂 anchor、标题映射到 `h4` 起；
  内容寻址 memo（200 条）；`dist/*.css` 进构建产物 minify，源码保持可读。
- `2026-10-26-install-gate.md` —— 安装门禁：后端算 `installedRelation`（`newer|same|older|
  unknown`），页面据此决定；同版本/降级/不可解析一律阻断，槽位换成「禁用主按钮 + 去 core
  卸载」。这是 UX 守卫，不是安全边界。
- `2026-10-26-product-author-surface.md` —— `ProductSummary.owner` 换成结构化 `author`
  （论坛账号 + 绑定仓库的 GitHub 账号，两半独立、缺半不发）；GitHub 链接用 `login` 重新拼；
  作者条放 README 顶部，文案写「GitHub 仓库账号」。
- `2026-10-26-platform-availability.md` —— 架构可用性：`ProductSummary.latestPlatforms`（卡片指向
  的那一版）与 `platforms`（候选并集）语义不同，两者不一致正是「最新版跑不了、旧版可以」的唯一
  信息来源；`platform=strict|all` 只放宽可见性，`all` 时 `compat` 只保留版本轴（否则开关无效果）；
  空数组=不知道、字段缺失=旧服务端回落并集；页面只是选择器，最终裁判在宿主 Core 的文件头闸门。
  附本次 dev 库被一次性脚本清空的教训：Bun 会自动加载 `.env.local`，脚本必须显式赋值目标库。
- `2026-10-26-arch-auto-detect.md` —— 架构不再由人挑：目录恒发 `platform=all`（产品不因异架构
  消失），删「只看支持当前架构」开关与安装条平台下拉，平台由 `defaultPlatform` 按宿主 `target`
  自动决定；卡片只留一枚架构判决（`支持当前架构` / `不支持当前架构` / `最新版不支持当前架构`），
  正向判决顶掉原始平台 chip，`supportedAnywhere === false` 时抑制兼容徽标。取代
  `2026-10-26-platform-availability.md` 的 UI 与默认口径，保留其数据契约与 `compatibility` 求值。
- `2026-10-26-single-extension-failure-isolation.md` —— issue 拆成平铺日志 + 两个归属桶
  （`byExtension` / `releaseWide`）：`release_versions.state` 只看自己那组与不可归属那组，
  `repo_releases.sync_state` 仍按整条 tag 记账；摘要不符时读一次包内清单只为定 hold 半径
  （用接受路径同一个 parser），下载/解析失败无从归属则整条 tag 连坐。
- `2026-10-26-retryable-sync-failures.md` —— 失败分可重试/不可重试：可重试（5xx/429/408/401、
  网络与瞬时 fs 错误）在 asset 循环里 rethrow，交给 pg-boss 重试（5 次、60 s 起指数退避、封顶
  600 s、`expireInSeconds` 1800），不写 issue 也不烧版本号；不可重试才落 `asset_failed`。
  版本行 + 审核事件 + 资产行同事务，`create_queue` 的 `ON CONFLICT DO NOTHING` 靠 `updateQueue`
  兜住，失败的 `getBoss()` 不再被缓存。
