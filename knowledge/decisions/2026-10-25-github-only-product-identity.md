# 产品身份单源化：只从 GitHub 导入、摘要 + README、社交预览

Date: 2026-10-25
Status: accepted
Plan: `plans/2026-10-25-github-only-products.md`

## 问题

开发者门户同时存在两条创建路径（手填表单 / 从 GitHub 导入）和三份可写的「介绍」：

1. `products.name` + `product_translations.name` 由人手填，与扩展清单的 `name` 无关；
2. `product_translations.description_md` 是一份长文案，与仓库 README 无关；
3. `products.icon_asset_id` 与 `product_screenshots` 是上传的图片，与仓库视觉无关。

三份都靠人同步，结果是同一件事有两个事实来源：清单改名而产品名不变、README 写了安装步骤而商城介绍没写、图标是设计稿而仓库预览是另一张图。审核台还要为「上传的图片」承担内容责任（图片可能侵权、可能含未声明的推广信息），而这份责任本来不该由商城承担。

## 决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | **关闭手动创建**：`POST /api/dashboard/products` 返回 `410 manual_create_disabled`，UI 只留「从 GitHub 导入」 | 手填的 `extension_id` 没有仓库能认领，必然产生孤儿行；导入路径从清单取身份，id/name/kind 一次对齐 |
| D2 | **名称锁定清单**：`syncRelease` 发现清单 `name` 变化时更新产品名（含默认语言 translation），已发布产品因此回审核 | 名称是目录里最重要的文案，不能有两个来源；`name_at_review` 已能表达「改过名，需要重看」 |
| D3 | **图标 = GitHub 社交预览**：服务端抓仓库页 `og:image` → 下载 → 内容寻址存 `assets` | 开发者不再上传，商城不再为图片内容负责；对外仍只发 `/api/assets/{sha256}`，不暴露上游 |
| D4 | **截图能力移除**：`product_screenshots` 表删除，画廊由 README 正文承担 | 截图是 README 的子集；保留它等于保留第二套媒体审核 |
| D5 | **介绍 = README 渲染**：`markdown-it` + `sanitize-html`，HTML 为唯一对外表示 | 仓库已经是介绍的唯一事实来源；契约只发 HTML，商城网页与插件共用一次渲染与一份白名单 |
| D6 | **README 图片不代理**：相对路径重写为 `raw.githubusercontent.com/<owner>/<repo>/HEAD/<path>` | 不引入「按 README 内容抓取任意 URL」的 SSRF 面，也不为每个访客触发一次出站请求 |
| D7 | **README 实时读，不进审核快照**：公开页读缓存，过期后台刷新；审核只覆盖摘要与清单 | 审核 README 等于审核一个随时会变的分支；与其假装审过，不如明确「介绍来自仓库」并把变更写进审计 |
| D8 | **摘要仍由人写**（≤300，必填），可从 README 首段一键填充 | 目录卡片需要一句人能判断的话；自动截取会产出半句话，且失去「作者自己说这是什么」的信息 |
| D9 | **私有仓库允许导入与发布**；预览图与 README 图取不到时占位 | 私有仓库是合法形态（企业内部扩展）；README 文字用 installation token 读，视觉缺失用字母块兜底 |

## 后果

**变简单的部分**

- 产品身份只有一条写入路径：release 里的清单。
- 商城不再存开发者上传的图片，也不再为图片内容背书。
- 契约从「纯文本 description + 截图数组」收敛成「一段已消毒 HTML」，插件端渲染逻辑只剩注入。

**变复杂的部分 / 已知缺口**

1. **审核不再覆盖介绍正文。** 开发者可以在审核通过后改 README，公开页会在缓存过期（≤15 分钟）后显示新内容。缓解：渲染白名单（无 `script`/`on*`/`style`、外链 `nofollow ugc`、图片 https-only）、README `sha` 变化写 `product.readme_changed` 审计、审核台显示当前 `sha` 与拉取时间。这是 D7 的明码代价，不是漏洞。
2. **访客 IP 交给 GitHub 与第三方图床。** D6 的直接结果。缓解：图片 `referrerpolicy="no-referrer"`、`http:` 图降级为文字链接。
3. **社交预览依赖未文档化的 HTML。** GitHub 没有社交预览 API，`og:image` 是唯一来源；`opengraph.githubassets.com` 实测 429，所以走仓库页 HTML。结构变化会让预览静默消失（返回 null → 字母块），不影响主流程。GHES 直接跳过。
4. **旧数据不可回滚。** 迁移 `0011` 清空 `icon_asset_id`、`product_screenshots`、`description_md`。升级前必须跑 `bun run backup:legacy-media`（dump 引用与 sha），`assets` 行与文件保留。

## 没选的方案

- **保留手动创建，只隐藏按钮**：接口仍可被脚本调用，等于规则只在 UI 成立。
- **README 快照进审核**：会得到「审过一版 README，公开页显示另一版」或「改 README 必须重新提交」两种结果，前者是假审核，后者把文案修订变成发布流程。选了实时读 + 审计。
- **代理 README 图片**：白名单可以做到安全，但需要为 gif/svg 徽章准备解码与转换，且每个访客都触发一次商城出站。当前阶段不值。
- **直接外链 `repository-images.githubusercontent.com`**：零存储，但暴露上游域名、把访客 IP 交给 GitHub，且私有仓库必然破图。
- **名称仍可手改**：会重新引入「清单名 ≠ 目录名」的漂移，而这正是本轮要消灭的东西。

## 验证

- `bun test`（含 README 渲染、摘要提取、社交预览抓取、README 刷新与审计）。
- 迁移 `0011` 在本地库跑通；`products` 只剩 `preview_*` 三列，`product_readmes` 存在，`product_translations` 无 `description_md`。
- 公开详情页渲染表格/代码块/`<details>`，`script` 与 `onerror` 不可达。
- 双视口（1633×810 / 390×844）截图见收尾交接。
