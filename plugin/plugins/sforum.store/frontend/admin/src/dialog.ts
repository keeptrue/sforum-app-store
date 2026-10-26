// 详情弹窗：挂在 `document.body` 上的居中对话框。
//
// 职责边界：本文件只管弹窗机制——遮罩、容器、三个分区的 ARIA 与键盘、Esc / 遮罩 / 关闭按钮、
// 焦点陷阱与归还、背景 `inert`、滚动锁；头部、分区内容、通知槽与底部安装条由 `catalog.ts`
// 通过 `header`、`tab(id).panel`、`notice`、`footer` 四个插槽渲染。安装态变化因此只重绘
// notice + footer，分区内容与滚动位置都不受影响。
//
// 为什么挂 body：`.sfstore` 上的 `container-type: inline-size` 会成为 fixed 后代的包含块，
// 遮罩放进页面根会被裁在内容列里。遮罩自带 `sfstore-dialog` 类，token 在 body 层同样命中。

import { el } from "./dom";
import type { Copy } from "./copy";
import type { DialogTabId } from "./types";

/** 遮罩层同时是 token 作用域：`.sfstore-dialog` 承载变量，`.sfstore__overlay` 负责定位。 */
export const DIALOG_OVERLAY_CLASS = "sfstore__overlay sfstore-dialog";

const TAB_DEFS: ReadonlyArray<{ id: DialogTabId; key: "tabReadme" | "tabVersions" | "tabNotes" }> = [
  { id: "readme", key: "tabReadme" },
  { id: "versions", key: "tabVersions" },
  { id: "notes", key: "tabNotes" },
];

/**
 * `:not()` 只有浏览器认识；测试替身的 querySelector 不支持复合伪类，会返回空列表，
 * 于是焦点陷阱在测试里自然退化为 no-op（替身本来也没有 tab 顺序语义）。
 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type DialogTab = { tab: HTMLButtonElement; panel: HTMLElement };

export type DialogHandle = {
  /** 遮罩层（fixed inset:0），点它本身才关闭。 */
  overlay: HTMLElement;
  /** 对话框盒子（role=dialog），事件委托与 aria 关系都挂在这里。 */
  surface: HTMLElement;
  /** 头部插槽：由 catalog 填入 `.sfstore__dialog-head`。 */
  header: HTMLElement;
  /** 滚动区内的通知槽（旧宿主签名块 / 已暂存回执 / 安装期间提示）。 */
  notice: HTMLElement;
  /** 唯一滚动容器：三个分区都住在里面。 */
  scroll: HTMLElement;
  /** 底部安装条插槽（flex 行）。 */
  footer: HTMLElement;
  tab(tabId: DialogTabId): DialogTab;
  /** 切换分区（不移动焦点）。 */
  activate(tabId: DialogTabId): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** 安装进行中：关闭按钮禁用，Esc 与遮罩点击都被忽略。 */
  setPending(pending: boolean): void;
  destroy(): void;
};

export type DialogOptions = {
  copy: Copy;
  /** 打开时加 `inert` 的背景根节点（插件自己的页面根）。 */
  background: HTMLElement;
  /** 关闭之后调用（重置选中态）；焦点归还先发生。 */
  onClose: () => void;
};

function getDocument(): any {
  return (globalThis as any).document ?? null;
}

function focusElement(node: unknown): void {
  const target = node as { focus?: () => void } | null;
  if (target && typeof target.focus === "function") target.focus();
}

function isTabId(value: unknown): value is DialogTabId {
  return value === "readme" || value === "versions" || value === "notes";
}

export function createDialog(options: DialogOptions): DialogHandle {
  const { copy, background, onClose } = options;

  const overlay = el("div", DIALOG_OVERLAY_CLASS);
  overlay.setAttribute("data-role", "dialog-overlay");

  const surface = el("div", "sfstore__dialog");
  surface.setAttribute("role", "dialog");
  surface.setAttribute("aria-modal", "true");
  surface.setAttribute("data-role", "dialog");

  const header = el("div");
  header.setAttribute("data-role", "dialog-header");

  const tablist = el("div", "sfstore__tabs");
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", copy.t("dialogTabsAria"));

  const scroll = el("div", "sfstore__dialog-scroll");
  scroll.setAttribute("data-role", "dialog-scroll");

  const notice = el("div", "sfstore__notice-slot");
  notice.setAttribute("data-role", "dialog-notice");
  scroll.append(notice);

  const footer = el("footer", "sfstore__dialog-foot");
  footer.setAttribute("data-role", "dialog-footer");

  const closeButton = el("button", "sfstore__dialog-close", "×") as HTMLButtonElement;
  closeButton.type = "button";
  closeButton.setAttribute("data-action", "dialog-close");
  closeButton.setAttribute("aria-label", copy.t("dialogClose"));
  closeButton.title = copy.t("dialogClose");

  const tabs = {} as Record<DialogTabId, DialogTab>;
  for (const def of TAB_DEFS) {
    const tab = el("button", "sfstore__tab") as HTMLButtonElement;
    tab.type = "button";
    tab.id = `sfstore-tab-${def.id}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("data-tab", def.id);
    tab.setAttribute("aria-controls", `sfstore-panel-${def.id}`);
    tab.textContent = copy.t(def.key);

    const panel = el("div", "sfstore__tabpanel");
    panel.id = `sfstore-panel-${def.id}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    panel.setAttribute("tabindex", "0");

    tabs[def.id] = { tab, panel };
    tablist.append(tab);
    scroll.append(panel);
  }

  surface.append(header, tablist, scroll, footer, closeButton);
  overlay.append(surface);

  let opened = false;
  let pending = false;
  let activeTab: DialogTabId = "readme";
  let previousFocus: unknown = null;
  let previousOverflow = "";

  function activate(tabId: DialogTabId): void {
    activeTab = tabId;
    for (const def of TAB_DEFS) {
      const entry = tabs[def.id];
      const selected = def.id === tabId;
      entry.tab.setAttribute("aria-selected", selected ? "true" : "false");
      entry.tab.setAttribute("tabindex", selected ? "0" : "-1");
      entry.panel.hidden = !selected;
    }
  }

  function focusTab(tabId: DialogTabId): void {
    focusElement(tabs[tabId].tab);
  }

  /** 打开期间锁住页面滚动；恢复时写回原来的内联值，不动宿主自己的样式。 */
  function lockScroll(lock: boolean): void {
    const style = getDocument()?.documentElement?.style;
    if (!style) return;
    if (lock) {
      previousOverflow = style.overflow ?? "";
      style.overflow = "hidden";
      return;
    }
    style.overflow = previousOverflow;
    previousOverflow = "";
  }

  function focusables(): HTMLElement[] {
    if (typeof surface.querySelectorAll !== "function") return [];
    const items = Array.from(surface.querySelectorAll(FOCUSABLE_SELECTOR)) as HTMLElement[];
    // 隐藏的 tabpanel 仍是 DOM 里的可聚焦节点（panel 自带 tabindex=0），
    // 不排除的话焦点陷阱的首/尾会落到看不见的分区上。测试替身没有 closest，
    // 可选调用让它自然全部保留。
    return items.filter((item) => !item.closest?.("[hidden]"));
  }

  function trapTab(event: any): void {
    const items = focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = getDocument()?.activeElement;
    if (event.shiftKey && (active === first || !active)) {
      event.preventDefault?.();
      focusElement(last);
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault?.();
      focusElement(first);
    }
  }

  function tabIdOf(start: unknown): DialogTabId | "" {
    let current: any = start;
    while (current && current !== tablist) {
      if (current.nodeType === 1 && typeof current.getAttribute === "function") {
        const value = current.getAttribute("data-tab");
        if (isTabId(value)) return value;
      }
      current = current.parentNode;
    }
    return "";
  }

  function onKeydown(event: any): void {
    if (!opened) return;
    const key = String(event.key ?? "");
    if (key === "Escape") {
      event.preventDefault?.();
      if (!pending) close();
      return;
    }
    if (key === "Tab") trapTab(event);
  }

  /** 点击切换分区；焦点由浏览器给到被点的 tab（键盘路径见 onTablistKeydown）。 */
  function onTablistClick(event: any): void {
    const id = tabIdOf(event.target);
    if (!id) return;
    activate(id);
  }

  function onTablistKeydown(event: any): void {
    const current = tabIdOf(event.target);
    if (!current) return;
    const index = TAB_DEFS.findIndex((def) => def.id === current);
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % TAB_DEFS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TAB_DEFS.length) % TAB_DEFS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TAB_DEFS.length - 1;
    if (next < 0) return;
    event.preventDefault?.();
    const id = TAB_DEFS[next].id;
    activate(id);
    focusTab(id);
  }

  function onOverlayClick(event: any): void {
    if (!opened || pending) return;
    if (event.target !== overlay) return;
    close();
  }

  function onCloseClick(): void {
    if (pending) return;
    close();
  }

  function open(): void {
    if (opened) return;
    opened = true;
    const doc = getDocument();
    previousFocus = doc?.activeElement ?? null;
    activate("readme");
    const host = doc?.body ?? background.parentNode ?? background;
    host.append(overlay);
    background.setAttribute("inert", "");
    lockScroll(true);
    focusTab(activeTab);
  }

  function close(): void {
    if (!opened || pending) return;
    opened = false;
    overlay.remove();
    background.removeAttribute("inert");
    lockScroll(false);
    const restore = previousFocus;
    previousFocus = null;
    // shim 不做「移除后 activeElement 回落」，浏览器也不是每次都回落到触发器，
    // 所以显式归还焦点；调用方自己的清理放在归还之后。
    focusElement(restore);
    onClose();
  }

  /**
   * 安装进行中：关闭按钮禁用，Esc 与遮罩点击都被忽略。
   *
   * 这里**不再**碰遮罩的 z-index。曾经的写法是「安装期间把遮罩降到 0，让宿主弹窗靠
   * DOM 顺序浮上来，结束后还原」，结果是宿主弹窗还开着、遮罩又回到 40，把它盖住，
   * 而宿主此时仍给 body 加了 pointer-events:none —— 整页点不动。层级由宿主负责
   * （宿主弹窗固定 z-[80]，本页遮罩 40 永远在它下面），插件不自造层叠。
   */
  function setPending(next: boolean): void {
    pending = next;
    closeButton.disabled = next;
  }

  overlay.addEventListener("click", onOverlayClick);
  overlay.addEventListener("keydown", onKeydown);
  tablist.addEventListener("click", onTablistClick);
  tablist.addEventListener("keydown", onTablistKeydown);
  closeButton.addEventListener("click", onCloseClick);

  return {
    overlay,
    surface,
    header,
    notice,
    scroll,
    footer,
    tab: (tabId: DialogTabId) => tabs[tabId],
    activate,
    open,
    close,
    isOpen: () => opened,
    setPending,
    destroy() {
      overlay.removeEventListener("click", onOverlayClick);
      overlay.removeEventListener("keydown", onKeydown);
      tablist.removeEventListener("click", onTablistClick);
      tablist.removeEventListener("keydown", onTablistKeydown);
      closeButton.removeEventListener("click", onCloseClick);
      if (opened) {
        opened = false;
        overlay.remove();
        background.removeAttribute("inert");
        lockScroll(false);
        previousFocus = null;
      }
    },
  };
}
