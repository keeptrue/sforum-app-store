# 产品身份单源化（只从 GitHub 导入 · 摘要 + README · 社交预览）

Date: 2026-10-25
Plan: `plans/2026-10-25-github-only-products.md`
Decision: `decisions/2026-10-25-github-only-product-identity.md`

## 本轮做了什么

产品不再由人「填写」，而是从 GitHub 派生：创建只剩「从仓库导入」，名称取自扩展清单，介绍取自
README，图标取自社交预览，截图与长文案两条输入整体消失。

**服务端**

- 迁移 `0011_github_only_products`：新增 `product_readmes`；`products.icon_asset_id` →
  `preview_asset_id`（+ `preview_fetched_at` / `preview_sha256`）；`DROP TABLE product_screenshots`；
  删 `product_translations.description_md`。
- `lib/readme/render.ts`：`markdown-it` + `markdown-it-task-lists` + `sanitize-html`。标题降一级、
  相对图重写为 `raw.githubusercontent.com/<owner>/<repo>/HEAD/<path>`、`http:` 图降级为链接、
  `data:`/SVG 丢弃、外链 `nofollow noopener noreferrer ugc`、`input` 只允许只读 checkbox。
- `lib/readme/summary.ts`：从 README 首段提取摘要（跳 frontmatter/badge/标题/代码块，句末截断）。
- `lib/github/social-preview.ts`：抓仓库页 `og:image` → 只接受
  `repository-images.githubusercontent.com` → 下载 → 魔数校验 → 内容寻址存 `assets`。GHES 直接跳过，
  任何失败返回 reason，不抛异常。
- `lib/github/readme.ts`：`GET /repos/{owner}/{repo}/readme`（base64，1 MiB 上限）→ 渲染 → upsert；
  `blob_sha` 变化或换绑时写 `product.readme_changed` 审计。
- `lib/products/preview.ts`：预览图落库并写 `products.preview_*`；失败保留旧图。
- `lib/products/readme-cache.ts`：15 分钟 TTL；公开详情页用 Next `after()` 后台刷新，60 秒进程内去重。
- `lib/github/sync.ts`：清单 `name` 与产品名不同 → `renameProduct`（含默认语言 translation），
  已发布产品因 `name_at_review` 不匹配回审核。
- `POST /api/dashboard/products` → `410 manual_create_disabled`；icon / screenshots 四条路由删除；
  新增 `POST .../readme/refresh` 与 `POST .../summary-suggestion`。
- `parseProductPatch` 只接受 `summary`/`category`/`tags`；`name`/`descriptionMd`/`defaultLocale`
  进 `NON_EDITABLE_FIELDS`（400 `field_not_editable`）。

**契约**：`ProductDetail` 删 `description`/`screenshots`，加 `readme: ProductReadme | null`
（`html` / `sourceUrl` / `sha` / `fetchedAt` / `byteSize`）。`ProductSummary.iconUrl` 保留字段名，
语义改为社交预览。

**前端**：`create-product-dialog`、`media-manager`、`screenshot-grid` 删除；新增
`components/dashboard/readme-panel.tsx`（渲染 + 元信息 + 重新拉取）；`copy-editor` 只剩摘要/分类/标签
与「从 README 生成」；公开页与审核台改为 `.readme` 容器渲染 HTML；`globals.css` 新增 `.readme`
作用域样式（含 `table { display:block; overflow-x:auto }` 与只读 checkbox）。

**插件**：Go 代理透传 `readme`（`mapping.go` + 响应 schema），管理页 `readmeBlock` 注入 HTML，
中英文案同步；`bash plugin/scripts/build.sh` 重跑并同步摘要。

**运维**：`bun run backup:legacy-media`（迁移前 dump 旧图标/截图/介绍引用，只读），
`docs/deployment.md` 升级步骤已加这一步。

## 验证

- `bun test --parallel=1` → **646 pass / 0 fail / 58 files / 2251 expect**。
- `bunx tsc --noEmit`（临时 `tsconfig.check.json`，不含 `.next` 生成类型）→ 0 error。
- `bun --bun next build` → 通过；`next start` + `/api/health` → 200。
- 迁移在本地库跑通并核验列：`products` 只有 `preview_*`，`product_screenshots` 不存在，
  `product_translations` 无 `description_md`。
- 插件：`go vet` + `go test` 通过；管理页 `bun test src` → 46 pass。
- 视觉（1633×810 / 390×844）：
  - 公开详情页 README（表格、代码块、任务列表 checkbox）：`/tmp/readme-pc-final.png`、
    `/tmp/readme-mobile-final.png`（scrollWidth = 390）。
  - 真实仓库 README（徽章、表格、长段落）：`/tmp/dashboard-readme-pc2.png`。
  - 开发者门户产品页（只剩摘要/分类/标签）：`/tmp/dashboard-detail-pc.png`。
  - 门户首页只有「从仓库导入」：`/tmp/dashboard-pc.png`（500 宽窗口截图，内容已确认）。
  - 移动端产品页修复前后：`/tmp/dashboard-readme-mobile.png`（scrollWidth 从 830 → 390）。

## 过程中发现并修掉的两个真实问题

1. **移动端横向溢出**：产品页 grid 的隐式 `auto` 列按 min-content 定宽，README 里一张宽表就把
   390px 页面撑到 830px。修法是 `grid-cols-1` + `.readme { min-width: 0; overflow-wrap: anywhere }`。
2. **`changed` 判据只看 `blob_sha`**：换绑到 README 摘要恰好相同的新仓库时，审计不会记
   `product.readme_changed`，且 `from` 指向旧仓库。判据已加 `previous.repoId !== target.repoId`。

## 未验证 / 已知缺口

- **真实 GitHub App**：README 与社交预览的抓取只对 fake 客户端与本地 fixture 跑过；真实
  installation token 下未跑（本轮没有可用 App）。
- **真实社交预览**：`repository-images.githubusercontent.com` 的匿名取图在 2026-10-25 手工 curl 验证
  200（公开仓库），但未在应用内对真实仓库跑完整链路。
- **审核不覆盖 README**：决策 D7 的明码代价。README 变更写审计，审核台显示 `sha` 与拉取时间。
- **GHES**：社交预览跳过（返回 `ghes`），README 走 `apiBaseUrl` 正常。
- **`.readme` 里的 SVG 徽章**：`img` 只允许 https，shields.io 的 SVG 图片在 `<img>` 上下文加载
  （不执行脚本），已通过真实仓库 README 截图确认可见。

## 环境改动（留给下一个会话）

- `service/.env.local` 未改。
- `store_settings.public_url` 本轮为登录截图临时 `--clear`，随后已 `--set` 回
  `https://test-sforum-app-store.dalao.me`（与之前一致）。
- `:4000` 现在跑的是 **生产构建**（`bun --bun next start`，日志 `/tmp/sforum-prod.log`），
  不是 `next dev`。`next dev` 在本机因 Turbopack 的 `Cannot find package 'pg-<hash>'` 起不来
  （删 `.next`、重装依赖都无效，与本轮改动无关，`next start` 正常）——需要单独排查。
- 本地库已 seed（3 个产品，均带 README）；另有 3 个历史产品（`demo-s4` / `demo-reject` /
  `fetch-url`），其中 `fetch-url` 属于 fake provider 登录账号。
- `service/tsconfig.check.json` 是本次为绕过 `.next` 生成类型缺失而加的临时检查配置，**未删除**
  （删了会让 `bunx tsc` 重新报 TS6053）；是否保留请人工决定。
