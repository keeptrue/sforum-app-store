# 2026-10-25 三面 UI 统一 + 三态主题 + 共享组件层

## 结果

后台不再「比前台更朴素」：管理员后台、开发者门户、审核台、前台目录现在挂**同一个
`AppShell`**（248px 轨 + 72px 顶栏 + 移动端 Sheet），差异只剩导航项与顶栏插槽。三面都有的
日夜/自动切换按钮由外壳统一渲染。表单对话框统一走 `Modal` / `ConfirmDialog`，卡片与标题排版
收敛到 CSS 工具类。

- `bun test --parallel=1` → **397 pass / 0 fail / 37 files**（新增 `theme.test.ts` 4 例）
- `bunx tsc --noEmit` 干净；`bun --bun next build` 通过，`next start` 重启后页面 200
- 视觉证据：1633×810（前台/后台 明+暗、门户/审核台 暗、模态框 明暗）、390×844（四个面，
  无横向溢出）。截图在 `tmp/ui-*.png`。

## 结构（新增/替换）

**主题（新增 `components/theme/`）**
- `theme.ts` —— 单一事实源：`ThemeMode = light|dark|system`、`store-theme` 键、
  `resolveTheme`、`applyThemeMode`、`THEME_BOOTSTRAP`（预绘制脚本字符串，读 storage + 监听
  `prefers-color-scheme`，显式 light/dark 不会被系统覆盖）。
- `theme-toggle.tsx` —— 三态分段控件（Sun/Moon/Monitor），跟随系统时监听 OS 变化，跨标签页
  同步走 `storage` 事件。旧的二态 `components/theme-toggle.tsx` 删除。
- `app/layout.tsx` 的内联脚本改为注入 `THEME_BOOTSTRAP`（不再有第二份字符串）。

**外壳（`components/shell/`）**
- `app-shell.tsx` —— 唯一外壳：品牌块、rail 导航槽、rail 页脚、顶栏左右插槽、移动端 Sheet、
  **顶栏固定渲染 `ThemeToggle`**；渲染 `<main>`，页面不再自带 `<main>`。
- `sidebar-nav.tsx` —— presentational 导航（`SidebarNavGroup[]`，`active` 由调用方计算）。
- `mobile-nav.tsx` + `ui/sheet.tsx` —— `lg` 以下用抽屉承载同一份导航；路径变化自动关闭。
- `store-nav.tsx` / `store-search.tsx` / `store-portal-card.tsx` 从旧 sidebar/topbar 拆出；
  `console-nav.tsx` + `console-shell.tsx` 取代 `site-header.tsx` + `site-nav.tsx`（已删）。
- `admin/admin-shell.tsx` 重写为 `AppShell` + 管理员导航 + 账号卡；`nav-items.ts` 改成
  「运营 / 配置」两组；旧 `AdminPageHeader` 删除。

**共享组件（`components/common/`）**
`page-header`、`section`、`stat`(+`StatGrid`)、`empty-state`、`field`(+`FormError`)、
`submit-button`、`modal`、`confirm-dialog`。

**对话框迁移**
`create-admin-dialog`、`issuer-dialog`、`create-product-dialog`、`yank-dialog`、
`moderation-dialog` 改用 `Modal`/`ConfirmDialog`（`Modal` 支持 `trigger`，footer 在表单外，
用 `form` 属性提交）。`install-dialog` 保留自定义头（产品图标 + 平台选择），仍用 dialog 原语。

**样式层（`globals.css`）**
- 新增 `--radius-control: 11px`、`--app-topbar-h`（72 / 移动端 64）。
- `@utility surface / surface-panel / surface-quiet / surface-dashed / page-title / page-lede /
  eyebrow / section-title`。21 处 `rounded-lg border border-border bg-card` 换成 `.surface`，
  证据块换 `.surface-quiet`。
- `color-scheme` 跟随 `.dark`；修复 `content-in` 关键帧：原来动画里又写了一次
  `translate(-50%,-48%)`，与 Tailwind v4 的 `translate` 属性叠加，模态框在动画期间被推偏一格。

## 验证证据

- 前台 1633×810：明/暗各一张；后台概览 1633×810 明/暗；账号、系统页 1633 明；
  门户/审核台 1633 暗；模态框（新建管理员）明/暗。
- 390×844 用同源 iframe（`width:390px`）实测四个面：`scrollWidth == clientWidth`，
  无横向溢出；截图 `tmp/ui-*-390.png`。
- 主题：点击三态按钮后 `documentElement.dataset.theme` 与 `localStorage["store-theme"]`
  同步；`system` 下 `resolveTheme` 有单测；旧二态键值（`dark`/`light`）继续被识别。

## 未验证（如实记录）

- **OS 级系统主题切换的运行时联动**：本机 CDP `Emulation.setEmulatedMedia` 不落到 ego 页面
  目标（`matchMedia` 仍报 false），因此「跟随系统时 OS 由亮转暗自动翻转」只有代码路径与
  单测，没有实机事件证据。验证方式：在真实桌面切换系统外观后观察 `<html class="dark">`。
- 插件管理页（`plugin/plugins/sforum.store/` 预构建 ESM）不在本次范围：它拿不到宿主的
  主题 token，日夜切换仍由宿主页面决定。
- 5 处 `window.confirm`（admin 账号表、论坛账号表、issuer 表）未换 `ConfirmDialog`，
  属后续清理项。
- 构建产物的 CSS chunk 名在两次构建间可能不变，浏览器会命中旧缓存：验收前需
  `Network.setCacheDisabled` 或强刷，否则会看到旧关键帧。

## 备忘

- 端口 4000 的 `next start` 已用新构建重启；验收注入的临时会话行（`admin_sessions` /
  `sessions`，`user_agent='ui-review'`）验收后删除。
- `tmp/` 截图不入库。
