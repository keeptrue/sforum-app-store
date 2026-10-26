# 更新说明走 README 同一条渲染链

Status: accepted
Date: 2026-10-26
Related: `2026-10-25-readme-rendering.md`（渲染器的形状与白名单）、
`2026-10-26-catalog-card-dialog.md`（把「不渲染 notes」列为已知取舍，本次取代）

## 背景

详情弹窗的「更新说明」分区一直是**纯文本**：`notes` 是 GitHub Release 原文，页面用
`white-space: pre-wrap` 原样贴出来。管理员的实际体验是一条条 `## 安装`、`- 支持…` 的
字面量，标题不成为标题、清单不成为清单。

当初把它排除在范围外的理由是「要跨仓改契约与 sanitize 策略」。这次量了代价后发现前提不成立：
商城**已经**有一条渲染 + 消毒链（`service/src/lib/readme/render.ts`，markdown-it +
highlight.js + sanitize-html 白名单），README 走的正是它。渲染 release body 不需要新的
渲染器，也不需要新的白名单 —— 只需要把同一套规则套到第二个文档上。

## 决定

1. **服务端渲染，`notesHtml` 与 `notes` 同时下发。** `notes` 保持 GitHub 原文（审计、以及
   想自己渲染的客户端）；`notesHtml` 是渲染并消毒后的 HTML。页面优先注入后者，缺失时退回
   前者的纯文本 —— 也就是老商城的行为不变。
2. **复用同一份规则与白名单，只换标题映射。** `render.ts` 抽出 `installRules()`（任务清单、
   `h1` clamp、fence 高亮、表格滚动容器），README 与 notes 各建一个实例。sanitize 的
   `sanitizeOptions(env)` 完全共用：一个渲染器、一份白名单，两个面口径一致。
3. **notes 不挂 `markdown-it-anchor`。** 一个弹窗里列出所有 release，生成的 heading `id`
   会跨版本撞车，`#` 永久链接会深链到错的版本；notes 也没有可跳转的目录。
4. **notes 的标题映射到 `h4` 起。** 弹窗标题是 `h2`，每个版本头改成 `h3`，正文的
   `#`/`##` 落到 `h4`、`###` 落到 `h5`、更深的落到 `h6`。理由与 README 把 `#` 压成 `h2`
   相同：GitHub release body 的常规章节层级是 `##`，整体下移两档会把 `###` 压到正文大小。
5. **`repoFullName` 可以为空。** 产品解绑仓库后旧 notes 仍要能渲染：相对图片/链接没有可解析
   的仓库时**丢弃**（图片保留 alt 文本、链接保留文字），绝不拼出
   `raw.githubusercontent.com//HEAD/…` 这种必然 404 的地址。
6. **读时渲染 + 内容寻址 memo（`lib/readme/notes.ts`，上限 200 条）。** 渲染是
   `(source, repoFullName)` 的纯函数，key 用 sha256，因此不需要失效逻辑；不落库，避免再造一列
   需要在渲染器或白名单变更时重跑的派生数据。上限让内存与目录规模脱钩：LRU 逐出只影响
   CPU，不影响正确性。
7. **顺带修掉清单没有项目符号。** 宿主管理端的 Tailwind preflight 把 `ol/ul` 的
   `list-style` 清成 `none`；商城自己的前台 CSS 早已显式补回 `disc/decimal`
   （`service/src/app/globals.css`），插件页漏了这一处。补上后 README 与更新说明的清单同时
   恢复。
8. **`dist/*.css` 也进构建产物（minify），源码保持可读。** 计划 §7.5 第 17 条的 20 KB 预算
   说的是**发布产物**。这块 UI 已经从一个表格页长成「卡片网格 + 三 Tab 弹窗 + 作者条」，
   继续靠删等量说明性样式来守 20 KB 只会让源码变差。现在 `bun build --minify` 产出
   **17,988 B**（源文件 23,277 B），`.mjs` 52,547 B / 81,920。

## 放弃的方案

- **客户端渲染 notes。** 要么把 markdown-it 与 sanitize 白名单打进页面（`.mjs` 预算本来就
  只剩一半），要么引第二个更弱的消毒器 —— 后者会悄悄改写内容，而真正的保证在服务端。
- **落库 `notes_html` 列。** 需要 rerender 脚本 + 失效规则；README 的 `product_readmes.html`
  是「抓取时一次成型」才成立的，release body 会在同步时反复更新。
- **每条 release 一个迷你渲染器/简化规则。** 两份规则一定漂移，漂移的表现是「README 里能
  渲染的语法在更新说明里失效」。

## 代价与重开条件

- **每次详情请求都要遍历所有 release 并做一次 sha256。** 命中 memo 时不重新渲染；未命中时
  渲染成本与 README 同级。memo 上限 200，超出后旧条目被逐出（重新渲染，不报错）。
- **`notesHtml` 与 README 共用 class（`.sforum-store-readme`）。** 好处是排版只有一份；代价是
  改 README 样式会同时影响更新说明 —— 这正是想要的，但改动时要意识到这一点。
- **表格容器的 `aria-label` 仍是中文硬编码**（`render.ts` 的 `TABLE_OPEN`）。这是 README 的
  既有问题，en-US 页面上会漏出中文；本轮不修（要按语言参数化 `renderReadme` 的签名）。
- 重开条件：出现独立 changelog 页（契约里预留的 `notesUrl`）时，把渲染结果缓存到那里，
  弹窗只取摘要。
