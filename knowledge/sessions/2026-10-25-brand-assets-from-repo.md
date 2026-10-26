# 品牌图跟随仓库：brand/icon.png 是源，四条触发 + 一个按钮

日期：2026-10-25
决策：`decisions/2026-10-25-brand-assets-from-repo.md`

## 起因

「插件的 icon / 品牌图怎么不会实时更新，也没有手动拉取的按钮。」

核实后是两个独立问题叠在一起：

- 商城的 `iconUrl` 全链路（目录卡片、详情页、门户、审核台）来自 `products.preview_*`，而写这一列
  的只有 `lib/products/preview.ts` → `lib/github/social-preview.ts`：抓**仓库页 HTML 的
  `og:image`**。那是 GitHub `Settings → Social preview` 里手传的图（GitHub 侧还有缓存），
  仓库里的 `brand/icon.png` **从来没被读过**。改仓库文件自然永远不生效。
- 唯一的手动路径是 README 面板里的「重新拉取」：它顺带刷图标，但前端只读 `readme.ok`，
  `preview` 结果直接丢掉。所以「brand 文件被拒」和「仓库根本没有品牌目录」在界面上完全一样。

宿主侧 meanwhile 已经把布局定死了：SForum `docs/extensions/brand-assets.md` 规定包内
`brand/icon.svg` / `brand/icon.png`（512×512，≤120 KiB）/ `brand/social-preview.png`
（1280×640，≤600 KiB），`sforum extension brand check` 守门，并明确把「商城详情页」留作后续消费者。

## 改了什么

**服务端**

- `lib/github/brand.ts`：只读两个常量路径（`brand/icon.png`、`brand/social-preview.png`），
  经 `GithubAppClient.getRepoFile`（Contents API + installation token，**私有仓可用**），
  `ref` = `github_repos.default_branch`，顺带拿 blob sha。
- `lib/products/brand.ts`（替换 `preview.ts`）：图标 `brand/icon.png` → 社交预览 → 字母块；
  分享卡独立一槽。blob sha 未变则不下载、只更新时间戳。宽松准入：图标任意方形 PNG ≤1 MiB，
  分享卡 2:1（±5%）PNG ≤1 MiB。**失败保留旧图**，原因写 `preview_error` / `og_error`，
  brand 槽位被拒写 `preview_note`。
- 迁移 `0013_product_brand_assets`：`products` 加 9 列（`preview_source`、`preview_blob_sha`、
  `preview_note`、`preview_error`、`og_asset_id`、`og_sha256`、`og_blob_sha`、`og_fetched_at`、
  `og_error`），纯加列，目录 join 一行未改。
- 四条自动触发 + 一条手动：
  - 绑定/导入（`binding.ts`，沿用原有位置）；
  - `release`：`syncRelease` 返回值新增 `productIds`，job 结束后逐个 `scheduleBrandRefresh`；
  - `push`：`MANIFEST_EVENTS` 加 `"push"`，`lib/github/push-filter.ts` 在**写
    `webhook_deliveries` 之前**过滤（默认分支 + 命中 `(^|/)brand/`，提交列表被截断按命中处理）；
  - 每日巡检：新队列 `brand-sweep`（pg-boss `17 4 * * *`，UTC），每轮 200 个、间隔 250 ms，
    只取 `upstream_state=connected` 且图标或分享卡超过 24 小时的；
  - 手动：`POST /api/dashboard/products/[id]/brand/refresh`（owner → 404；`repo` 限流通道）。
- `readme/refresh` 不再碰图标（它现在只刷 README）。

**门户**

- 新组件 `components/dashboard/brand-panel.tsx`，放产品页左栏首位：88px 图标、来源
  （`brand/icon.png` / GitHub 社交预览 / 未设置）、抓取时间、sha 前 12 位、`preview_note` /
  `preview_error` 文案、分享卡缩略图与状态、「刷新品牌图」按钮（未绑仓库置灰）。
- 产品页 `generateMetadata`：`og_sha256` 存在时输出绝对 `openGraph.images`
  （`<publicUrl>/api/assets/<sha>`，带真实宽高）+ `twitter.card=summary_large_image`。
  新增 `catalog/query.ts:loadProductSocialImage`，刻意不把这个字段塞进 `/api/v1` 契约。

**插件面板**

- Go `mapping.go`：`iconUrl` 用设置里的 https 基址拼成绝对地址（`absoluteAssetURL`，拼不出就 nil），
  目录与详情共用。
- 手写 ESM：`view.ts` 的 `markEl` 在字母块里放 `<img>`（`alt=""`、`loading=lazy`、
  `referrerpolicy=no-referrer`），`onerror` 移除图片露出首字母；`catalog.css` 加
  `.sfstore__tile { overflow: hidden }` 与 `.sfstore__tile-img`。
- **不引入图片代理**：商城不进论坛请求链路，图片是公开的内容寻址资产，浏览器直连商城。

**文档与知识库**

- `docs/developer.md` §5 重写（契约表 + 触发时机 + 故障表 3 行）、`docs/github-app.md`
  （事件表加 `push` + 已安装 App 需补勾）、`docs/plugin.md`（面板图片来源与 CSP 退路）、
  `AGENTS.md`（身份第 8 条、事件订阅、出站白名单、图片准入）、
  `contracts/store-api.yaml` 的 `iconUrl` 描述。

## 证据

- 服务端：`bun run test` **731 pass / 0 fail**（新增 `products/brand.test.ts` 13 条、
  `products/brand-sweep.test.ts` 4 条、`products/brand-refresh-route.test.ts` 5 条、
  `github/push-filter.test.ts` 10 条）；`bun run typecheck` 干净；
  `contract:generate` 后 `api-types.ts` 无 diff（只改描述）。
- 插件：`bun test plugin/plugins/sforum.store/frontend/admin/src` **50 pass / 0 fail**（新增 4 条
  图标渲染/降级）；`go vet ./...` + `go test ./...` 绿；`bash plugin/scripts/build.sh`
  重建 dist 与摘要、清单校验 OK（3 routes、1 admin page）。
- 未验证（需要真实 App 与浏览器会话）：① 真实仓库 push → 图标在 60 s 内变（本地只能证明过滤与
  调度逻辑）；② 已安装 App 补勾 `push` 后的投递（需要 GitHub 侧操作）；③ 面板 `<img>` 在宿主
  管理页 CSP 下是否加载（public 页是 `img-src 'self' data:`，管理页未设该头，按未验证处理）；
  ④ 1633×810 / 390×844 的品牌图面板目视（本次只走了源码与单测）。

## 修订：品牌目录在包目录里（当日 bug 修复）

上线到 `test-sforum-app-store.dalao.me` 后立刻暴露：`zhuchunshu/sforum-oauth2-provider`（该账号已改名
`keeptrue`，旧路径依赖 GitHub 301 仍有效）的文件在
`plugins/sforum-oauth2-provider/brand/`，而第一版只读仓库根的 `brand/`，于是根路径 404 →
图标退回社交预览、分享卡报错。宿主契约写的是**包内** `brand/`，包目录可能是仓库根，也可能是
`plugins/<name>/`。

修法：

- `lib/github/brand.ts:locateBrandDir`：根清单 → 递归树（≤4 MiB，截断即放弃）→ 含清单的目录
  （≤5 个）→ 用清单 `id` 比对 `extension_id`；单候选直接采用，多候选无匹配则不猜并写
  `brand_layout_ambiguous`。一次刷新最多一次树列举，`brand/` 在根时零额外调用。
- `lib/github/client.ts:listRepoTree`：路径/类型解析、`truncated`、4 MiB 上限、非 JSON 报 502。
- 失败码带状态：`fetchBrandFile` 的 `github_error` 携带 HTTP 状态，面板显示
  `social_file_github_403` 这类具体代码；新增 `brand_read_failed` 注释码。
- 面板文案改为「扩展包目录里的 brand/icon.png（与 sforum.extension.json 同级）」。

证据（真机，非夹具）：

- `bun --env-file=.env.local` 直接调 `refreshProductBrand` 打真实 GitHub：图标 `brand_icon`，
  blob `68e7fe49…`、资产 sha `ccd40356…`、512×512 / 39976 B；分享卡 blob `549a6470…`、
  1280×640 / 84961 B。
- 生产构建 + `next start`，带会话取产品页：面板「来源 brand/icon.png / 抓取于 18:46 /
  sha256 ccd40356ed93」，分享卡「brand/social-preview.png · 18:46」，页面两处 `<img>` 分别指向
  两个资产；`/api/assets/ccd40356…` 返回 `image/png`、39976 B。
- 单测：`brand.test.ts` 18 条（新增 5 条布局用例）、`client.test.ts` 3 条树列举用例。

## 追加：分享卡也当目录卡片封面

「背景图还没改」—— 目录卡片的封面位一直是分类色板，`brand/social-preview.png` 只用在 OG 上。

- 契约 `ProductSummary.socialImageUrl`（可空，内容寻址），目录与详情都带；`catalog/query.ts`
  用 `alias(assets, "og_assets")` 第二次 join，避免与图标的 join 互相覆盖。
- 目录卡片：有分享卡就把 1280×640 铺在 152px 封面位（`object-cover`，`onError` 隐藏露出底板），
  没有就维持原色板 + 圆环。
- 注意：宿主品牌模板把标题烧进了分享卡，所以卡片标题会出现两次（封面一次、下方一次）。要纯图封面
  得改 `scripts/brand/generate.mjs` 的版式，不在商城侧。

## 下一步

- 有真实 App 时：在 `sforum-oauth2-provider` 上跑一遍「改 `brand/icon.png` → push → 看卡片」，
  并把 `webhook_deliveries` 里被丢弃的 push 计数作为过滤效果的证据。
- 面板图标若被宿主 CSP 拦住，退路是停在字母块（不改架构），或由宿主放行 `img-src`。
