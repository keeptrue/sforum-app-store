# Decision: Brand assets come from the repository

## Status

Accepted

## Date

2026-10-25

## Context

The catalog's product mark was **GitHub's social preview**: `lib/github/social-preview.ts`
scrapes the repository page HTML for `og:image` and stores that bitmap. Two consequences showed
up as a product complaint:

1. **A `brand/` edit never reached the card.** The `og:image` is the picture uploaded in
   `Settings → Social preview`, not a file in the repository. A developer could replace
   `brand/icon.png`, push, cut a release — and the store kept showing the old picture forever.
2. **There was nowhere to fix it.** The only refresh path was the README panel's
   「重新拉取」 button, which quietly also refreshed the mark and discarded the result. A
   rejected brand file and a repository that never had one looked identical.

Meanwhile the host settled the layout: SForum `docs/extensions/brand-assets.md` and
`knowledge/decisions/2026-10-25-extension-brand-assets.md` put `brand/icon.svg`,
`brand/icon.png` (512×512, ≤120 KiB) and `brand/social-preview.png` (1280×640, ≤600 KiB) inside
every package, gate them with `sforum extension brand check`, and explicitly leave the consumer
work ("管理页插件卡、商城详情页") for later. This is that later.

## Decision

- **Source order for the mark**: `brand/icon.png` → GitHub social preview → letter tile.
  The fallback is not politeness; most repositories never adopted the layout, and dropping the
  social preview would blank their cards.
- **The card is a second slot**: `brand/social-preview.png` feeds the product page's
  Open Graph image (`products.og_*`) **and the catalog card's cover**, never the icon. A 512
  square makes a bad link preview and a 1280×640 card makes a bad 36px tile.
- **Read through the Contents API with the installation token**, `ref` = the repository's
  default branch. Brand assets describe the product, not a release, so a tag would freeze them.
  The blob `sha` comes back in the same response and is stored: an unchanged file costs one
  call and no download.
- **Loose admission, host keeps the contract.** The store accepts any square PNG ≤1 MiB
  (`brand/icon.png`) and any 2:1 PNG ≤1 MiB (`brand/social-preview.png`). Rejecting a 600×600
  icon would leave a published product with no mark, over a rule the store does not enforce
  anywhere else; `sforum extension brand check` is the gate for the package itself.
- **Four refresh triggers**: bind/import, `release` webhook, `push` touching `(^|/)brand/` on
  the default branch, and a daily sweep in the worker. Plus one explicit button
  (`POST /api/dashboard/products/[id]/brand/refresh`).
- **`push` is filtered before it is stored.** It is the noisiest GitHub event; the route drops
  every delivery that did not move the default branch into a `brand/` path before
  `webhook_deliveries` gets a row. A truncated commit list counts as "touched" — the refresh is
  conditional, so a false positive is one API call.
- **A failed refresh never blanks the mark.** The previous asset stays; the reason lands in
  `preview_error` / `og_error` and the dashboard's brand panel prints it.
- **No image proxy for the plugin panel.** The panel renders the store's content-addressed URL
  as an absolute address (`<store>/api/assets/<sha>`), because proxying through the forum would
  put the store inside the forum's request chain, which the whole project exists to avoid. An
  `onerror` handler restores the letter tile.
- **Icon changes do not re-enter review.** The mark is decorative, validated as a bitmap, and
  cannot execute anything; review still covers the name and the capability set.

## Consequences

- New columns on `products`: `preview_source`, `preview_blob_sha`, `preview_note`,
  `preview_error`, `og_asset_id`, `og_sha256`, `og_blob_sha`, `og_fetched_at`, `og_error`
  (migration `0013_product_brand_assets`). Additive; the existing `preview_*` pointers and the
  catalog join are untouched.
- The store now reads a second file per product from GitHub. Cost per product per day: one
  contents call for the icon, one for the card, usually answered without a download. The
  installation token's quota (5000/h) is the ceiling; the daily batch is capped at 200 products
  with a 250 ms gap.
- **Installed Apps do not gain `push` automatically.** Manifest creation only covers new Apps.
  Without the event, real-time degrades to release + daily + manual, which is documented rather
  than silently broken.
- `brand/icon.svg` is deliberately unread: the asset store refuses SVG (a scriptable document),
  and the host contract makes `icon.png` mandatory whenever the layout is adopted. A repository
  that ships only the SVG keeps its social preview.
- The product page gains `generateMetadata` with an absolute `openGraph.images` URL. The public
  `/api/v1` contract does not grow a second image field: the card is metadata for the store's
  own HTML, not part of the catalog DTO the plugin consumes.

## 修订（2026-10-25 当日）：目录是**包目录**，不是仓库根

第一版把路径写死成仓库根的 `brand/icon.png`。真实仓库 `keeptrue/sforum-oauth2-provider`
的品牌图在 `plugins/sforum-oauth2-provider/brand/` 下（宿主契约说的是「包内 `brand/`」），
于是根路径 404、图标悄悄退回社交预览，分享卡直接报缺失/报错 —— 用户看到的就是「文件明明
在，商城说没有」。

- **定位规则**：先读仓库根的 `sforum.extension.json`（根级包，最常见）；不是就列一次仓库树
  （`git/trees?recursive=1`，4 MiB 上限、截断即放弃），取所有含清单的目录（≤5 个），用清单
  `id` 与产品的 `extension_id` 比对；只有一个候选时直接采用，多个都对不上就**不猜**，把
  `brand_layout_ambiguous` 写进面板。
- **文件名仍是常量**：目录由清单位置推导，文件名 `icon.png` / `social-preview.png` 不可由
  清单或输入扩展；一次刷新最多一次树列举，`brand/` 在根时零额外调用。
- **错误码带状态**：`github_error` 现在携带 HTTP 状态（`social_file_github_403` 之类），
  「没有这个文件」与「令牌没权限」不再长得一样 —— 这次的 404/403 混淆就是它造成的。
- 验证：对真实仓库跑一次刷新，`preview_source=brand_icon`、blob `68e7fe49…`、资产 512×512
  / 39976 B；分享卡 1280×640 / 84961 B；门户面板显示「来源 brand/icon.png」。
- **封面也要用起来**：`ProductSummary.socialImageUrl` 进契约（目录与详情都带），目录卡片把分享卡
  铺在封面位；没有分享卡时退回分类色板与圆环图案。分享卡上自带标题文字，所以卡片标题会出现两次 ——
  这是宿主品牌模板的写法，要纯图封面得改模板。

## Alternatives rejected

- **Keep the social preview and only add a button.** Smallest diff, but it keeps asking
  developers to maintain the same picture in two places, and the file they already ship stays
  unread.
- **Rasterise `brand/icon.svg` server-side.** Needs `sharp`, which the stack bans; the PNG is
  already the contract's master file.
- **Serve the icon through a plugin route.** `mode: "http"` routes marshal a JSON document, and
  an image proxy would make the forum carry store traffic. Absolute URLs + `onerror` is both
  smaller and architecturally correct.
- **Strict 512×512 / 120 KiB admission.** Would reject real icons over a rule that only the
  host's own checker can enforce with authority.
