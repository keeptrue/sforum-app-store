# 2026-10-25 品牌资产统一：logo 与网站标签页 icon

## 结果

`SForum/apps/web/public/brand/sforum-logo.svg`（sha256 `cc455c87…`）已复制进本仓，
作为商城**唯一**品牌资产：页面 logo 与浏览器标签页 icon 指向同一份文件。`bun run build`
通过；`tsc --noEmit` 通过；无新增依赖。

## 为什么是共享文件而不是内联 SVG

`AGENTS.md` 禁止手绘内联 SVG 图标。这里更进一步：logo 与 favicon 共用**同一个文件**，
而不是「页面内联一份、meta 再指向一份」。内联副本会和标签页的副本各自漂移——改一次品牌
就得改两处，漏一处就出现「页面是新 logo、标签页还是旧的」。`<img src="/brand/…">` 与
`metadata.icons` 指向同一 URL，浏览器各自请求同一份字节，不可能漂移。

## 改动清单

- `service/public/brand/sforum-logo.svg` —— 复制的源资产，未改动内容（sha256 与 SForum
  仓逐字节一致）。**SVG only，不生成 favicon.ico / apple-touch-icon PNG。**
- `service/src/components/brand-mark.tsx`（新增）—— 唯一的渲染入口。`size` 是渲染盒，
  字形落在资产自带 padding 内（310 viewBox 里字形约占 3/4），所以视觉标记略小于盒。
  `alt=""`：旁边的 wordmark 已经承载名称，重复一次对屏幕阅读器是噪音（与 `ProductMark`
  的既有约定一致）。
- `service/src/app/layout.tsx` —— `metadata.icons`：`icon`（`image/svg+xml` +
  `sizes="any"`）、`shortcut`、`apple` 全部指向 `/brand/sforum-logo.svg`。SSR HTML 实测
  三个 `<link>` 都在。
- `service/src/components/site-header.tsx` —— Console 顶栏（56px）的字母砖 → logo。
- `service/src/components/shell/store-sidebar.tsx` —— 前台左侧 rail 的品牌块。
- `service/src/components/shell/store-topbar.tsx` —— 移动端顶栏（`lg:hidden`）。
- `service/src/components/admin/admin-shell.tsx` —— 后台 rail 顶部。
- `service/src/components/admin/admin-auth-shell.tsx` —— 登录/改密/注册三页（居中卡片）。

## 尺寸

桌面 rail 34px、顶栏 30px、后台 rail 22px、认证页 24px。glyph 是 310 viewBox 的 stroke
字形，按盒缩放后在浅/深两套主题下都成立（资产自带蓝色渐变，不依赖 `--primary` 反色）。

## 验证

- `bun run build` → exit 0，路由表正常，`public/` 静态资源进入产物。
- `tsc --noEmit` → exit 0。
- 渲染证据（ego 浏览器，`http://127.0.0.1:4000`）：
  - 前台 1633×810 / 390×844：rail 34px、顶栏 30px 均在位，无溢出。
  - 后台 console 1633×810 / 390×844：rail 22px 在位，导航与内容正常。
  - 登录页 1633×810：24px 标记与 wordmark 水平对齐。
  - DOM 取证：`document.querySelector('link[rel=icon]').href === '/brand/sforum-logo.svg'`，
    `apple-touch-icon` / `shortcut icon` 同值。
  - 截图存于 `tmp/brand-*.png`（`tmp/` 不入库）。

## 未做 / 边界

- **插件管理页不加 logo。** `plugin/plugins/sforum.store/` 的 ESM 管理页是宿主 admin 内的
  嵌入组件，它的「标签页」是 SForum 后台自己的 tab，品牌面属于宿主。要在里面放 logo 需要
  把 SVG 打进预构建包并改 `plugin/scripts/build.sh` 的复制步骤——本次未做，保持宿主边界。
- **SVG favicon 在旧版 Safari 上可能被忽略**（Safari 对 `image/svg+xml` 的支持晚于
  Chrome/Firefox）。已声明 `apple` icon 作为 iOS 兜底。工具链没有栅格化器
  （`rsvg-convert`/`inkscape`/`convert` 均缺位），且 `AGENTS.md` 明确不引入 `sharp`，
  所以不生成 PNG/ICO 副本。
- **深色主题下的可读性未单独出证据**：资产自带 `#2671ed → #1f6bec` 渐变，深色背景上
  对比度充足，但未做深浅两套截图对比。
