# 2026-10-25 顶栏路由进度条

## 结果

三面共用外壳的顶栏底部多了一条 2px 墨线：点击后约 100ms 出现，等待期间按指数曲线爬升、
94% 封顶，超过 1.2 秒改为呼吸脉动，URL 真正提交时补齐到 100% 再淡出。它要区分的是
「点了、服务端还在渲染」和「点了没反应」——本产品每一页都是服务端渲染，这两种情况在浏览器里
原本长得一模一样。

- `bun test src/lib/nav-progress.test.ts` → **14 pass / 0 fail**
- 浏览器实测（1633×810、390×844，CDP 把 RTT 限到 1.4–1.5s）：
  `idle → running(8%) → stalled(41.9%→55.4%) → settling(100%) → idle`，
  提交时 `<a href>` 已换成新路由；整条时间线见「验证证据」。
- 截图：`tmp/nav-progress-mid-1633.png`（等待中，46.8%）、
  `tmp/nav-progress-zoom.png`（3× 放大，线压在顶栏下边框上）、
  `tmp/nav-progress-complete-1633.png`（提交瞬间）、
  `tmp/nav-progress-390-zoom.png`（移动端 4× 放大）。

## 结构

**`service/src/lib/nav-progress.ts`（新增，纯逻辑，无 DOM）**
- `NAV_PROGRESS_TIMING` —— 一条时间线：`start 0.08` / `ceiling 0.94` / `tauMs 2000` /
  `tickMs 200` / `showDelayMs 100` / `stallMs 1200` / `watchdogMs 20000` / `settleMs 300`。
- `advanceProgress(value, elapsedMs)` —— 向 94% 的指数逼近。**可加性**：两次 200ms 与一次
  400ms 落点相同，所以后台标签页里迟到的 tick 不会掉队；`value` 是当前位置不是起点，
  重复调用不会重复计时。
- `shouldTrackClick(intent)` —— 只有「同源 + 同文档内真实换页」才算：排除外链、
  `target`、`download`、修饰键、非 http(s)、以及**路径与 query 都没变**的点击（点击当前页、
  `#anchor`）。入参是纯对象，所以能脱开 DOM 测。
- `reduceNavProgress(state, action)` —— `idle | running | settling` 状态机；
  `start` 在 running 期间是空操作（第二次点击不把线拽回 8%），每个定时器动作在错相位一律忽略。
- `startNavProgress()` / `subscribeNavProgress()` —— 给「没有可拦截的点击」的导航用的入口。

**`service/src/components/shell/nav-progress.tsx`（新增，客户端）**
- `useReducer` + 三个 effect：定时器（show / tick / stall / watchdog，随相位清理）、
  settling 后的卸载定时器、文档捕获阶段的 click 监听。
- 捕获阶段是必须的：`next/link` 自己在 onClick 里 `preventDefault` 接管导航，冒泡阶段读
  `defaultPrevented` 永远是 true。所以只看结构特征，不看 `defaultPrevented`。
- 结束信号只有一个：`usePathname()` + `useSearchParams().toString()` 变化 → `commit`。
  query-only 的导航（目录筛选）也要，所以两者都读。
- 渲染两个节点：`role="status"` 的 `sr-only` 文案（「页面加载中」，出现即播报一次）与
  `aria-hidden` 的线本身。读屏用户拿到的不是「进度百分比」而是「点击生效了」。

**`service/src/components/shell/app-shell.tsx`（改）**
- 顶栏（`sticky`，本身就是定位祖先，不需要额外 `relative`）末尾挂 `<Suspense fallback={null}>`
  包住的 `<NavProgress />`：外壳不能因为一条 2px 线把每一页都踢出静态渲染。

**`service/src/app/globals.css`（改）**
- `.nav-progress` 家族：宽度=进度值，`data-phase` 决定透明度与过渡，`data-stalled` 决定脉动；
  `prefers-reduced-motion` 下只关动效、不关信息。

**四处 `startNavProgress()`（改）**
- `dashboard/create-product-dialog.tsx`、`import-product-dialog.tsx`、`claim-button.tsx`
  （异步动作成功后 `router.push` 到新产品页）、`storefront/catalog.tsx` 的 `setPlatform`
  （`<Select>` 触发的服务端重渲染，没有链接可拦）。

## 取舍

- **不用 `useLinkStatus`**：它是 per-link 的，只覆盖 `<Link>` 且拿不到「这条线现在到哪了」；
  壳里的导航、`router.push`、`<Select>` 都盖不住。**不用 `popstate`**：App Router 的前进后退
  多数走缓存，且只改 hash 的 popstate 没有任何提交信号，线会卡到看门狗。
- **94% 封顶**：只有 URL 变了才配到 100%。「不知道还剩多少」是事实，画出来就是撒谎。
- **100ms 显示延迟**：预取的导航几十毫秒就结束，每次点击闪一条线比没有线更像 bug。低于阈值
  用户根本不知道有线；高于阈值说明他真的等了。
- **提交时不总是补到 100%**：只有「已经跑过一格」（≥1 次 tick，约 200ms）才补齐；否则保持
  原宽度淡出。否则一次 150ms 的导航会看见线突然铺满整条顶栏——比它要说明的事更抢眼。
- **1.2s 后改呼吸**：线爬到 90% 需要十几秒，中途停住和没有线一样。脉动动的是 `filter`
  不是 `opacity`：`opacity` 动画会压过 `settling` 的淡出过渡，实测提交时线是硬消失的。
- **20s 看门狗**：路由在原地抛错时 URL 不会变，线不能爬一整个会话；下一次点击重新开始。
- **零 layout 影响**：线的容器 `absolute`、状态文案 `sr-only`（也是 absolute），顶栏的 flex
  行不变。

## 验证证据

一次限速导航（1633×810，RTT 1.4s，点击目录卡片）：

| t | phase | width | opacity |
| --- | --- | --- | --- |
| 5ms | idle（未过显示延迟） | 8% | 0 |
| 136ms | running | 8% | 0.21（淡入中） |
| 1199ms | running + stalled | 46.8% | 1 |
| 3771ms | idle（新路由已提交） | 0% | 0 |

query-only 导航（点击「插件」筛选，`/?kind=plugin`）：`running → settling(100%) → idle`，
且 `data-probe` 标记的同一个节点贯穿全程（`useSearchParams` 没有让 Suspense 回退、没有重挂载）。
跨路由组（`/` → `/dashboard`）时外壳会重挂载，线直接消失而不是淡出——可接受，等待已经结束。

**未验证 / 环境问题**
- `bunx tsc --noEmit` 有一个错误，在 `service/src/lib/readme/render.ts`（`Tag.attribs`），
  与本改动无关：该文件在本轮进行中被另一个写入者改过（05:24:42）。因此 `next build` 没跑
  （构建会连带类型检查失败）。
- 全量 `bun test`：550 pass / 57 fail。失败全部是**吃数据库的测试文件**（settings、issuers、
  github、claims、admin 等），根因是本地测试库缺 `product_screenshots` 关系——迁移没跑，
  `beforeAll` 一挂整个文件跟着红。与本改动无关，`nav-progress` 的 14 例全绿。
