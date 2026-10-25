# 只从 GitHub 导入的产品身份（摘要 + README + 社交预览）

Status: **active（2026-10-25 人工批准并实施）**
Started: 2026-10-25

- **权威副本**：本文件。
- **前置**：`plans/2026-10-24-app-store-service.md`（S0–S6）、`plans/2026-10-25-admin-console.md`。
- **性质**：架构变更。产品的「文案与媒体」从「开发者填写 + 上传」变成「GitHub 单源派生」。
- **决策记录**：`decisions/2026-10-25-github-only-product-identity.md`。

## 1. 目标

1. 开发者门户只保留「从 GitHub 导入」；手动创建从 UI 与 API 同时关闭。
2. 图标来自 GitHub 社交预览，截图上传移除。
3. 文案只剩摘要由人写；介绍 = 仓库 README，实时读取并渲染。
4. 名称由扩展清单驱动，不再手填。

**非目标**：README 多语言、README 站内搜索、README 版本历史、README 图片代理、审核后 README 变更强制回审、GHES 社交预览。

## 2. 落地结果（与批准的决策逐条对应）

| 决策 | 实现位置 |
| --- | --- |
| 关闭手动创建 | `POST /api/dashboard/products` → `410 manual_create_disabled`；`create-product-dialog.tsx` 删除；`seed-dev.ts` 直调 service |
| 名称锁定清单 | `lib/github/sync.ts` 调 `renameProduct`（同时改默认语言 translation）；`name_at_review` 触发 hold |
| 图标 = 社交预览 | `lib/github/social-preview.ts` + `lib/products/preview.ts`；`products.preview_asset_id` |
| 截图移除 | 迁移 `0011` 删表；4 条上传路由删除；`media-manager.tsx`、`screenshot-grid.tsx` 删除 |
| 介绍 = README | `lib/readme/render.ts`（markdown-it + sanitize-html）、`lib/github/readme.ts`、`product_readmes` 表 |
| 图片不代理 | 渲染期把相对路径重写为 `raw.githubusercontent.com/<owner>/<repo>/HEAD/<path>` |
| 实时读 | `lib/products/readme-cache.ts`：15 分钟 TTL，公开页用 `after()` 后台刷新，60 秒进程内去重 |
| 摘要手写 | `copy-editor.tsx` 只剩摘要/分类/标签；`POST .../summary-suggestion` 用 `lib/readme/summary.ts` |
| 私有仓库 | README 文字走 installation token；预览图 404 → 字母占位 |

## 3. 数据模型

新增 `product_readmes`（缓存，不是审核快照）：

```
product_id uuid pk → products(id) cascade
repo_id    bigint not null        -- 换绑后旧缓存作废
ref        text not null default 'HEAD'
path       text not null
blob_sha   text not null          -- 变更审计的判据
markdown   text not null          -- 源，用于重渲染与摘要提取
html       text not null          -- 唯一对外表示
byte_size  integer not null
fetched_at timestamptz not null
fetch_error text                  -- 失败时保留上次成功内容
```

`products`：`icon_asset_id` → `preview_asset_id`，新增 `preview_fetched_at`、`preview_sha256`。
删除：`product_screenshots` 表、`product_translations.description_md`。

## 4. 契约（`contracts/store-api.yaml`）

- `ProductDetail`：删 `description`、`screenshots`；加 `readme: ProductReadme | null`。
- 新增 `ProductReadme`：`html`（消毒后）、`sourceUrl`（GitHub blob 页，永不含 API/资产地址）、`sha`、`fetchedAt`、`byteSize`。
- `ProductSummary.iconUrl` 保留字段名，语义改为社交预览（服务端抓取、内容寻址）。

## 5. 渲染与安全

- `markdown-it`：`html: true`（`<details>`/`<picture>` 可用）+ `linkify`，标题统一降一级。
- `sanitize-html` 白名单：标题/段落/列表/表格/`pre`/`code`/`details`/`a`/`img`；禁 `style`、`class`、`on*`、`iframe`、`form`；图片只允许 `https:`。
- 外链：`rel="nofollow noopener noreferrer ugc"` + `target="_blank"`；站内锚点不加。
- 相对图片：`URL` 规范化后重写到 raw；`http:` 图降级为文字链接；`data:`/`blob:`/`file:` 丢弃并保留 alt 文本。
- 非 Markdown README（`.rst`/`.txt`）渲染为 `<pre>`，不猜格式。
- 出站白名单扩为：GitHub API、`github.com`（仅仓库页 HTML，取 `og:image`）、`repository-images.githubusercontent.com`（仅图片）。抓取 URL 由库里的 `repo.full_name` 构造，不接受用户提交地址。

## 6. 刷新时机

| 触发 | 行为 |
| --- | --- |
| 导入成功 | 同步拉 README + 预览图（失败不阻断导入） |
| release 同步 | 与导入同一条路径（`syncRelease` 之后由导入/认领调用） |
| 公开详情页 | 缓存超过 15 分钟 → `after()` 后台刷新，本请求渲染旧值 |
| 手动 | `POST /api/dashboard/products/{id}/readme/refresh`（`repo` 限流通道，同步返回） |

失败语义：保留上次成功内容，写 `fetch_error`；dashboard 面板显示失败原因，公开页不受影响。

## 7. 迁移

1. `bun run backup:legacy-media` → `tmp/legacy-media-<ts>.json`（图标引用、截图行、介绍文本、资产 sha 与文件是否存在）。
2. `bun run db:migrate`（`0011_github_only_products.sql`）。
3. `assets` 行与磁盘文件保留；`/api/assets/{sha256}` 仍可访问，但不再被页面引用。

## 8. 测试与验收

- `lib/readme/render.test.ts`：表格/代码块/`<details>`、相对图重写、`../` 夹取、`http:` 降级、`javascript:` 与 `script` 剥离、plain-text 兜底。
- `lib/readme/summary.test.ts`：frontmatter/badge/标题/代码块跳过、列表标记剥离、句末截断、空 README。
- `lib/github/social-preview.test.ts`：`og:image` 两种属性顺序、非白名单域、404、超限、非位图、网络失败。
- `lib/github/client.test.ts`：README base64 解码、1 MiB 上限。
- 服务端集成：`PATCH` 拒绝 `name`/`descriptionMd`、`POST` 410、README 缓存与换绑失效、审核详情 README、刷新审计。
- 插件：Go 代理 fixture 与前端解析/渲染。
- 视觉：1633×810 与 390×844。

## 9. 遗留

- **审核不覆盖 README 正文**（决策 D7 的代价）。缓解见决策记录「后果」第 1 条。
- README 变更审计只在刷新时写，纯浏览不写（无读者时不会产生噪音）。
- 预览图抓取是未文档化行为，结构变化时静默退回占位。
- `ProductSummary.iconUrl` 字段名保留旧名（语义已变），改名会波及插件端，留给下一次契约版本。
