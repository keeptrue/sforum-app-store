# 2026-10-28 商城详情让位：宿主回报「已在跑」后收起弹窗

**起因**：宿主（SForum core）的「安装并启用」成功后，宿主的成功弹窗盖在商城详情弹窗上，
两层同时讲同一件事；用户点「去插件页」时还容易把两层一起带到下一个页面。

**范围**：商城管理页 `catalog.ts` 的 `startInstall`（bridge 安装链路）。
**不在范围**：宿主弹窗的按钮与跳转时序（见 SForum 仓
`knowledge/sessions/2026-10-28-install-dialog-handoff.md`）、暂存/失败态的回执展示。

## 改法

`startInstall` 在 `receiptState(result)` 之后记一个 `closeOnReceipt`，只在
`state.install.status === "enabled"`（含 `outcome === "upgraded"`）时为真；
在 `finally` 里 `refreshInstallArea()` **之后**再 `dialog.close()`。

顺序不能颠倒：`dialog.close()` 会拒绝在 `pending` 状态下关闭，而 `pending` 只有
`refreshInstallArea()` 里的 `setPending(state.install.pending)` 才会解除。

`staged` **不关**：回执里有「去 core 启用」的交接入口，关掉就把入口弄丢了。
`partial` / `failed` 同样保持打开 —— 那里有原因和重试。

## 代价

回执 DOM 随弹窗消失，`enabled` / `upgraded` 两种结果的文案断言从回执搬到 toast
（`notifyReceipt` 用的还是同一组 key：`enabledTitle` / `enabledNote` / `upgradedTitle` /
`upgradedNote`）。`staged` / `partial` / `failed` 的回执用例原样保留。

再次打开同一产品会重置安装状态（`openProduct` 里的 `state.install = freshInstall()`），
所以回执不会「复活」——这是有意的：宿主弹窗已经讲过一遍了。

## 证据

- 源码：`plugin/plugins/sforum.store/frontend/admin/src/catalog.ts`（`startInstall`）。
- 用例：`catalog.test.ts` 三条改写 —— 「a host with installAndEnableExtension enables the
  package and says so」（断言 `.sfstore__overlay` 已移除 + toast 文案）、
  「outcome upgraded reports an upgrade, never a fresh install」（同上）、
  「pending never rewrites the overlay z-index」（释放后遮罩被移除、层级全程未改写）。
- `bun test plugin/plugins/sforum.store/frontend/admin/src`：**219 pass / 5 files，0 fail**。
- `bash plugin/scripts/build.sh`：`digests: 1 updated`（`catalog.mjs`），
  `manifest OK: sforum.store 0.1.7 (plugin), 7 routes, 2 admin pages`。

## 未验证

真机没跑：本机宿主的 dev 实例装的是旧包（0.1.5/0.1.6），要看到新行为得先用新版商城
装一次扩展。复核方式：宿主回报「已启用/已升级」后，`document.body` 里不应再有
`.sfstore__overlay`；toast 仍是「已启用 / 宿主已启用这个扩展，不用再去 core。」
