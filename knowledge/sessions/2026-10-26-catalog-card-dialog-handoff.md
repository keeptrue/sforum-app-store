# 2026-10-26 商城目录：卡片网格 + body 级详情弹窗

## Changed

- **目录**（`frontend/admin/src/view.ts`）：一行一条 → 卡片网格（封面 2:1、徽标 5 槽位、
  `+N` 溢出、空态/错误态/骨架屏换壳）。「可更新」只在封面角标出现一次，徽标行不再重复。
- **详情**（新增 `frontend/admin/src/dialog.ts`）：常驻右栏 → 挂 `document.body` 的居中弹窗，
  三个 Tab（README / 版本信息 / 更新说明），底部 64px 安装条常驻；Esc / 遮罩 / 关闭按钮三路关闭，
  关闭后焦点还给触发卡片；安装中拒绝关闭；背景 `inert` + 滚动锁。
- **样式**（`frontend/admin/src/catalog.css`）：`container-type: inline-size` +
  `@container` 1120 / 940 / 552 → 4 / 3 / 2 / 1 列；`--sfstore-accent-ink` 接管文字、描边、
  焦点环（暗色取 `--sf-accent-dark`）；≤640 弹窗转全屏 sheet。
- **兼容口径**：新增 `auto`（跟服务端回显走），显式 `compatible` 现在真的发 `?compat=compatible`
  （以前省略）。后端契约仍是 `compatible|all`，不冲突。细节见「修复轮」第 6 条。
- **未改**：安装语义与错误码映射一行未动（成功仍是「已暂存」，启用/信任在 core，旧宿主仍发
  签名链接）；`copy.ts` 只加弹窗与网格词条，zh-CN / en-US 键集仍一致；`store-api` 契约未动。
- 清单 `sforum.extension.json` 两处摘要随产物更新：`admin` `f541286f1860…`、
  `admin-style` `3c1c9088efd1…`，与 dist 实算一致；其余字段未动。

## 修复轮（真实宿主暴露，已修并复测）

1. **主按钮 hover 变白底白字。** CSS 特异性：`.sfstore__btn:hover:not(:disabled)`（0,3,0）压过
   `.sfstore__btn--primary`（0,1,0）。修法：把 `:hover:not(:disabled)` 并进 primary 的选择器列表，
   hover 只留 `filter: brightness(1.06)`。
2. **点安装看不到宿主确认框。** Nuxt UI 4 的 `UModal` overlay/content 没有 z-index（靠 DOM 顺序），
   我们的遮罩 z-40 压在它上面。**现行修法：层级归宿主** —— core 给确认弹窗固定 `z-[80]`
   （`ADMIN_HOST_DIALOG_Z_INDEX`），插件遮罩保持 40，安装期间**不再改自己的 z-index**。
   早期「安装期间把遮罩降到 0」的写法已删除：它会在弹窗仍开着时把遮罩还原回 40，整页点不动。
3. **用户主动取消不再弹红色错误 Toast。** `install_cancelled` 只写 footer 状态位，其它失败码
   仍走错误 Toast。
4. **宿主确认框关闭后显式归还焦点。** 安装结束会重绘 footer，原按钮节点消失，宿主焦点归还没有
   落点（`activeElement` 落到 body，Esc 再也到不了 overlay）。修法：重绘后若焦点不在弹窗内，
   就交回主按钮；主按钮此刻禁用（已暂存）则交关闭按钮。
5. **卡片徽标从「收缩省略」改成「整枚换行」。** 3 列宽度下 5 枚徽标曾被压成「插…」「v…」；
   `.sfstore__card-meta` 改 `flex-wrap: wrap`，各档 `metaOverflow=0`。
6. **compat 口径修正。** dev 宿主后端默认 `all` 并回显 `compat`，前端新增 `auto` 跟回显走；
   显式 `compatible` 现在会真的发 `?compat=compatible`（以前省略）。后端契约 `compatible|all`
   已核，不冲突。

## Evidence

- `bun test plugin/plugins/sforum.store/frontend/admin/src` → **89 pass / 0 fail / 681 expect**。
- 产物：`dist/catalog.css` **20,403 B**（门禁 20,480，余量 **77 B**）、
  `dist/catalog.mjs` **47,066 B**（门禁 81,920）。
- 真机（内置浏览器，已登录，**1331×948**）：
  - 3 列 / 7 张卡，徽标全文本，同排等高 **320px**；
  - hover 实测 `background rgb(37,99,235)` + 白字；
  - 宿主确认框可见（截图 `/home/inkedus/下载/sfstore-host-install-dialog-2.png`）；
  - 取消后 `toastCount=0`、焦点回主按钮、`overlayZ` 回 40；
  - Esc 关闭且焦点回卡片；Tab / Shift+Tab 双向回绕；`documentElement.style.overflow`
    打开时 `hidden`、关闭后恢复空。
- CDP harness（`/tmp/sfstore-visual/`，与当前 dist 同 sha256；本轮 `?metrics=1` 复测）：
  - 列数 1633×810 → **4**、1280×810 → **3**、1024×900 → **2**、390×844 → **1**；
    各档 `metaOverflow=0`、`pageOverflow=0`、同排 `rowSpread=0`；
  - 弹窗宽 **1040 / 1040 / 960 / 390**，高 **713 / 713 / 780 / 844**（同序：1633、1920、1024、390）；
  - footer 桌面四态（默认 / 旧宿主 / 已暂存 / 安装中）恒 **65px**（`min-height:64px` + 1px 上边框）；
    390 档为两行网格，111px；
  - 安装期间遮罩 `z-index` 恒为 40（不再随 pending 改写）；安装中按 Esc 弹窗保持打开；Esc 关闭后焦点回 `product-1`；
    版本信息、更新说明两个 Tab 底部都有「安装到论坛」；「加载更多」9 → 12 张卡。

## Decisions

改版取舍见 `decisions/2026-10-26-catalog-card-dialog.md`：列数走容器查询（侧栏可拖 14–22rem，
视口断点会错判）、弹窗挂 `body`（`container-type` 会成为 fixed 包含块）、固定高避免 footer 跳、
安装语义不动、notes 纯文本、5 槽位徽标、`--sfstore-accent-ink` 只解决暗底对比度。

## Next

- 补 1633×810 与 390×844 两档真机截图（内置浏览器视口固定，目前这两档只有 CDP harness 证据）。
- 下一轮若还要加视觉，先按「删等量样式」腾预算，或正式提出扩 §7.5 第 17 条的预算。
- 远端封面图加超时降级（当前只保证不破图，见 Open Questions）。

## Open Questions

- **CSS 只剩 77 B**：后续任何视觉增补必须先删等量样式；要不要把 20 KB 预算提高，需要计划层决定。
- **焦点陷阱在 Bun 的 DOM 替身里测不了**：`focusables()` 用 `:not()` 复合选择器，替身不支持 →
  单测里天然 no-op，只能靠浏览器验收；是否给替身补复合伪类支持，未定。
- **真机截图只覆盖 1331×948**：1633×810 与 390×844 目前只有 CDP harness 证据，等内置浏览器能改
  视口或换一台能开窗的机器再补。
- **远端封面图在资产域慢时会长时间挂起**：加载中显示 `accent-soft` 底色、不破图，**未做超时降级**。
- **已知限制（有意为之）**：弹窗不写 URL（无深链）；版本表不列每版本资产文件；弹窗头部不重复
  平台列表（完整平台在安装条下拉里）。
