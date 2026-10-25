# 2026-10-24 UI/UX 重做（签名管道设计语言）

## 结果

`service/` 前端视觉层全量重做完成。设计方向「签名管道」：商城的性格是精密分发工具而非
消费级电商——版本、SHA-256、平台矩阵、semver 约束这些「核对证据」升为视觉主角。三个面
（storefront / dashboard / moderation）约 26 个文件改动，数据流、API、store、session、
路由参数零改动。`bun run build` 通过，`bun run test` 308 pass / 0 fail。

## 设计系统（全部落在 token，页面不写死颜色）

- **品牌色**：深青，`--primary: oklch(0.47 0.085 200)`（深色主题反转为亮青
  `oklch(0.79 0.09 195)`）。刻意避开 SaaS 默认蓝（260 色相）与 AI 常见 terracotta。
- **新增 token**：`--evidence` / `--evidence-foreground` —— 摘要、版本约束等证据块的底色。
- **字体**（next/font 自托管，globals.css `@theme inline`）：
  - `--font-display` = Space Grotesk → 大数字、统计、h1、版本号（`.font-display` utility，
    tabular 数字 + 收紧字距）。
  - `--font-mono` = JetBrains Mono → 只用于机器证据（版本/摘要/平台/约束/扩展 ID）。
    人读文案（中文状态名、人名、时间）一律 sans，这条线队友已按规范执行。
  - 中文正文走系统栈，不引入 CJK 网络字体（体积换不来语气）。
- **深色主题一等公民**：完整 `.dark` 变量块；`layout.tsx` 内联 bootstrap 脚本防闪烁
  （localStorage `store-theme` → 回退 `prefers-color-scheme`）；`ThemeToggle`（client，
  仅翻转 class + 持久化）放在 header。500px 视口下 toggle 被 `md:` 断点隐藏，跟随系统。
- **布局骨架统一**：版头 = border-b + h1 `text-2xl font-display font-semibold
  tracking-tight`；统计 = `font-display tabular-nums` 大数字；卡片静态无阴影、hover 才提升。
- **删除装饰性入场动画**：目录卡片原有 motion fade/slide-up 会把 SSR 内容卡在
  `opacity:0`（水合后动画未触发，目录网格整页空白——实锤截图 + DOM 取证
  `style="opacity:0"`）。全部移除；SSR 内容无 JS 可见。motion 只剩对话框/拖拽/focus 反馈。

## 改动清单

Lead（storefront + 骨架）：
- `service/src/app/globals.css` —— token 全套重写（浅/深双主题、evidence、字体变量）。
- `service/src/app/layout.tsx` —— next/font 两枚变量、深色 bootstrap、suppressHydrationWarning。
- `service/src/components/theme-toggle.tsx`、`site-nav.tsx`（新增）；`site-header.tsx`（导航
  三入口 + aria-current 高亮 + ThemeToggle + 搜索保留 GET form）。
- `service/src/app/page.tsx` —— hero 重排（标题 + 说明 + 收录/本页大数字）。
- `service/src/components/storefront/catalog.tsx` —— 卡片重做（整卡链接、版本号 font-display
  锚点、hover 提升）、类型 segmented 控件、删入场动画；`product-view.tsx` —— SHA-256/
  约束/大小入 evidence 块、版本表版本号 font-display、「它来自哪里」evidence 化；
  `product-mark.tsx` —— fallback 统一 accent 色调（原主题黄色块废弃，类型由徽章表达）；
  `catalog-error.tsx`、`install-dialog.tsx` —— 骨架对齐、步骤编号 font-display。

dashboard-ui 队友（6 文件）：`app/dashboard/page.tsx`（三列欢迎面板，01/02/03 步骤编号）、
`product-list.tsx`（版本证据列 font-display text-lg）、产品编辑页版头、not-found、
`review-panel.tsx`（人读文案去 mono）、`create-product-dialog.tsx`（去装饰 Badge）。

moderation-ui 队友（9 文件）：审核台版头统计 font-display、`queue-panel.tsx`（选中态
`bg-accent` + `border-l-primary` 指示条 motif）、`console-section.tsx`（分区标题 2px 主色
tick）、`version-table.tsx`（扁平表、语义色对齐）、`capability-diff.tsx`（warning 待审色）、
`event-timeline.tsx`（中文状态名去 mono）、`workflow-hint.tsx`（release tag 恢复 mono）、
`moderation-dialog.tsx`（计数器去装饰 mono）。

## 验证证据

- 桌面 storefront（1633×810）：目录卡片、hero、侧栏、版本锚点 —— 截图存
  `/tmp/store-after-home.png`。
- 移动（观察窗物理 500×864，<768 断点）：目录卡片单列无溢出（`/tmp/store-mobile-cards.png`）、
  详情页 evidence 块与 CTA（`/tmp/store-detail-mobile2.png`）、深色模式详情页
  （`/tmp/store-detail-dark2.png`，computed bg=深色确认）、dashboard 列表与编辑页
  （`/tmp/dashboard-mobile.png`、`/tmp/dashboard-product.png`）、moderation 队列选中态
  （`/tmp/moderation-mobile.png`）。
- 验收会话通过临时插入 `sessions` 行 + CDP `Network.setCookie`（`store_session`，http 下无
  `__Host-` 前缀）注入 admin 会话，验收后已删除（`user_agent='ui-review'` 清理确认）。

## 未验证（如实记录）

- dashboard / moderation 的**桌面断点（≥1280px）截图**：本环境观察窗物理宽度被锁 500px，
  CDP device-metrics override 与窗口管理器互相冲突（override 报 1344/1633 但
  `innerWidth` 恒 500，React resizable panels 的 ResizeObserver 测量随之塌陷，截图出现
  假性窄列）。已核实布局代码按响应式类书写且 500px 渲染正确；桌面断点需要真实宽窗口
  复验。
- 深色模式下的 dashboard / moderation（同受窗口限制；token 驱动，storefront 已验证深色
  链路）。
- fullPage 截图在长页有拼接伪影（卡片 DOM 实测可见、opacity 1），截图工具限制，非页面问题。

## 备忘

- 队友跑 `bun run build` 会清 `.next`，把运行中的 `next dev` 打挂（Turbopack）；验收期
  dev/build 不要并发。当前 4000 端口 dev 已停止。
- `.env.local` 的 `STORE_PUBLIC_URL` 是 http → cookie 名 `store_session`（无 `__Host-`
  前缀）；https 部署时会自动变为 `__Host-store_session`。
