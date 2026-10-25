# README 渲染：clamp 标题、class 高亮、容器化表格

Status: accepted
Date: 2026-10-25

## 背景

产品页的 README 是访客判断「这个扩展能不能装」的主要依据，但它一度只是「被 Tailwind preflight
削平的一段 HTML」。三处具体缺陷，都有线上证据：

1. **标题层级塌陷。** 渲染器把每个标题 +1 级（`#`→`h2`、`###`→`h4`），而 `.readme h4` 是 `1em`。
   实测 `sforum-oauth2-provider` 的 README 有 11 个 `h3` + 6 个 `h4`，`h4` 计算字号 13px，与正文
   同大——「安装」读起来只是一行加粗文本。
2. **表格里的截图不可读。** `.readme table { display: block }` 与 `border-collapse: collapse`
   互相打架：`thead` 与 `tbody` 各自解析列宽，`td` 没有宽度约束，`img { max-width: 100% }` 跟着
   匿名单元格缩水，两张并排截图实测只有 85px / 110px 宽。
3. **代码语言信息在 sanitize 阶段就丢了。** `allowedAttributes` 没有 `code` 的 `class`，线上
   HTML 是裸的 `<pre><code>`，8 个代码块全部没有语言标记。

另外记录一条**非渲染**结论：截图里「README 完全没样式」是缓存造成的，不是 CSS 缺失。浏览器
加载的 `_next/static/chunks/[root-of-the-server]__….css` 只有 86 条规则、`transferSize: 0`
（磁盘缓存命中），同 URL 加 `?v=` 重取是 118 条规则且 `.readme` 全在；响应头
`cache-control: max-age=14400, must-revalidate` + `cf-cache-status: REVALIDATED`，而 dev 的
chunk 名是固定的。**改完样式必须硬刷新或 purge，否则看到的仍是旧 CSS。**

## 决定

### 1. 标题用 clamp，不用整体下移

`h1 → h2`，`h2..h6` 原样。理由：+1 会把最常见的章节层级（`###`）压到 `h4`，而 `h4` 必须和正文
同大才不至于让 `#`/`##` 与 `###` 抢戏；不 shift 又会出现两个 `h1`（页面自己的产品名 + README）。
clamp 之后文档大纲仍是「页面 `h1` → README `h2`/`h3`」，而 `#` 与 `##` 同为 `h2` 的情况由
`.readme > h2:first-child`（文档标题，1.55em、无下划线）与其余 `h2`（章节，1.32em、有下划线）
在视觉上分开。

### 2. 高亮用 highlight.js，不用 shiki

shiki 输出内联 `style="color:…"`，而 sanitize 必须继续禁 `style`：任意内联 CSS 来自不可信仓库，
等于给它一个覆盖整页的钓鱼/遮挡原语。highlight.js 输出 `hljs-*` class，可以精确白名单；同时它
是同步的，而 HTML 在同步 worker 里渲染并落库。代价是 token 粒度比 TextMate 语法粗，接受。

颜色不引入新色相：`--code-string/--code-number/--code-comment/--code-meta` 是
`--success/--warning/--muted-foreground/--destructive` 的别名，深色主题自动跟随（`var()` 在
使用处解析）。

### 3. 表格由渲染器包一层容器，不用 CSS 的 `display: block`

`display: block` 在 `<table>` 上会让 `thead`/`tbody` 变成匿名表格盒，各自算列宽（已知的错位
bug）；`table-layout: fixed` 又会毁掉宽窄不均的表格。容器 div 让表格保持自己的布局，滚动发生在
外层，并且可以给容器 `role="region" tabindex="0" aria-label`（键盘可滚，WCAG 2.1.1）。
代价是白名单要多放行一个 `div`，但它的属性被限死在 `readme-table` / `readme-code` 两个 class 上。

### 4. 交互注入，不回写存量 HTML

复制按钮、图片放大、目录都挂在客户端组件上，`dangerouslySetInnerHTML` 的子树保持惰性。理由：
库里存的是文档，chrome 变了不该触发第二次迁移；而 `product_readmes.markdown` 已经存了原文，
需要重建 HTML 时跑 `readme:rerender` 即可。

### 5. 目录从已存的 HTML 派生，不进契约

`lib/readme/headings.ts` 用一个小正则从 `product_readmes.html` 里取 `{id,label,level}`，作为
props 传给目录组件。这样 `product_readmes` 不用加列、`contracts/store-api.yaml` 不用改形状、
回填脚本不用管目录；同时目录是**服务端渲染**的，禁用 JS 也在，且不会在 hydration 后才冒出来把
内容顶下去。只有「当前读到哪一节」需要浏览器（`IntersectionObserver`），那本来就依赖滚动位置。

先前的实现是在挂载后读 DOM，代价是 SSR 里没有目录、移动端会闪一下；改成派生后同一份 HTML 供
服务端与客户端使用。正则之所以可以接受：输入是我们自己渲染器的输出，形状由
`markdown-it-anchor` 固定，匹配不到只会少几项目录，不会错。

## 代价与已知边界

- 放行 `div` 后，README 自己写的 `<div>` 会保留标签但丢掉所有属性（包括 `class`），渲染为无样式
  块——可接受，且无法借此拿到脚本能力。
- 标题 `id` 只接受 `[\p{Letter}\p{Number}_-]+`，但**没有加前缀**：作者若手写 `id="main"` 仍可能
  与页面结构撞车，影响的只是该页锚点跳转。保留无前缀是为了让 GitHub 上的 `#安装` 深链在商城
  同样可用。
- `:has()` 用于徽章行（`p:has(> a > img):not(:has(> :not(a)))`），Safari 15.4+/Chrome 105+/
  Firefox 121+ 支持；不支持时退化为普通段落换行。
- 卡片从 `overflow-hidden` 改成 `overflow-clip`：`hidden` 会让卡片成为最近的滚动容器，
  `position: sticky` 的目录因此永远贴在卡片顶部不动。`clip` 不创建滚动容器，圆角裁切仍生效。

## 验证

- `service/src/lib/readme/render.test.ts`：38 条（含中文 id 去重、别名映射、未知语言转义、
  表格容器、`align` 保留、`class`/`style` 仍被剥离）。
- 线上样本 `sforum-oauth2-provider`：18 个标题 id、67 个 `hljs-*` span、8 个复制按钮、
  两张表格截图各 291px（原 85/110px）、徽章同排。
- `readme:rerender` 两次：`变化 6` → `变化 0`（幂等）。
