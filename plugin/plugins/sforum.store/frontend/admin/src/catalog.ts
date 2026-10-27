// SForum 应用商城管理页（Admin Micro-frontend API v1，预构建 ESM）。
//
// 约束（见 AGENTS.md 与 knowledge/plans/2026-10-24-app-store-service.md §7.5）：
// - 只通过 `bridge.request` 访问插件自己的三条路由，不主动发跨域请求、不加载外部字体。
//   产品图标是商城的内容寻址资产，由插件后端拼成绝对地址、浏览器直连商城：
//   `<img>` 加载失败就退回字母块，绝不显示破图。README 由商城渲染并消毒后整体注入，
//   其中的图片属于 README 内容本身（GitHub 托管）。
// - 安装只走宿主页面动作：宿主提供 `installAndEnableExtension` 时装完由宿主自己启用，
//   否则退回 `installExtension`（成功语义只是「已暂存」）。启用与信任的判断永远在宿主，
//   本页只转述宿主回报的 `outcome`，从不自己启用、不自己判定信任。
// - 手写 ESM 拿不到 Host 图标运行时：所有按钮用文字，不用 emoji、不手绘内联 SVG。
// - 页面标题与简介由宿主页面壳渲染；本页只负责目录、弹窗与安装条。

import { createAuthController } from "./auth";
import { createCopy } from "./copy";
import { createDialog } from "./dialog";
import { readProductQuery } from "./deep-link";
import { buttonEl, el, fieldEl, selectEl, toggleEl } from "./dom";
import { footNodes } from "./foot";
import {
  CORE_INSTALL_PATH,
  INSTALL_URL_PATH,
  buildCatalogPath,
  buildInstallRequest,
  buildInstallUrlBody,
  buildProductPath,
  categoryOptions,
  channelOptions,
  classifyFailure,
  compatibilityNote,
  corePathForKind,
  defaultPlatform,
  findRelease,
  formatDateTime,
  installGate,
  installGateText,
  installFailureCode,
  installFailureText,
  installableReleases,
  parseCatalog,
  parseInstallUrl,
  parseProduct,
  readInstallOutcome,
  resolveAppliedCompat,
  toCatalogItemView,
  toProductView,
} from "./logic";
import type { AppliedCompat, ChannelChoice, CompatMode, FailureClass } from "./logic";
import { platformId, preferredRelease } from "./platform";
import {
  DIALOG_TITLE_ID,
  authorStrip,
  catalogCardView,
  catalogSkeletonCards,
  dialogHeaderFromItem,
  dialogHeaderFromView,
  notesBlock,
  partialBlock,
  readmeBlock,
  receiptBlock,
  signedBlock,
  stateBlock,
  trustNote,
  versionsBlock,
} from "./view";
import type {
  CatalogItemView,
  CompatibilityDto,
  HostInstallEnableOutcome,
  HostInstallRequest,
  HostInstallResult,
  InstallGate,
  InstallUrlResponseDto,
  Kind,
  PageBridge,
  PlatformDto,
  PlatformOption,
  ProductDto,
  ProductView,
  ReleaseView,
} from "./types";

export const apiVersion = 1 as const;

const SEARCH_DEBOUNCE_MS = 220;

type CatalogMode = "loading" | "setup" | "error" | "ready" | "empty";
type DetailMode = "idle" | "loading" | "setup" | "error" | "ready";
type InstallStatus = "idle" | "running" | "staged" | "enabled" | "partial" | "failed" | "signed";

type InstallState = {
  status: InstallStatus;
  /** 宿主回报的启用结论；null = 旧宿主（没有 enable 方法）或还没装。 */
  outcome: HostInstallEnableOutcome | null;
  message: string;
  result: HostInstallResult | null;
  signed: InstallUrlResponseDto | null;
  pending: boolean;
};

type State = {
  query: string;
  channel: ChannelChoice;
  category: string;
  /** 兼容性口径：`auto` 交给商城按宿主决定；显式模式才向路由追加 `compat`。 */
  compatMode: CompatMode;
  /**
   * 当前结果集实际生效的口径（服务端回显，或 `auto` 下按 estimated 推断）。
   * 开关勾选状态与页级说明都跟它走：开发版宿主默认显示全部时，开关必须是未勾的。
   */
  appliedCompat: AppliedCompat;
  /** 目录请求在飞（首屏、筛选、刷新、加载更多都算）。 */
  loading: boolean;
  /** 正在追加下一页：保留现有卡片，只在底部显示「正在加载…」。 */
  appending: boolean;
  catalogMode: CatalogMode;
  errorText: string;
  /** 加载更多失败：网格保留，错误显示在按钮上方。 */
  appendError: string;
  items: CatalogItemView[];
  total: number;
  nextCursor: string | null;
  target: PlatformDto | null;
  stale: boolean;
  fetchedAt: string;
  /** The store's own verdict for this page; `null` until the first load lands. */
  pageCompatibility: CompatibilityDto | null;
  selectedSlug: string;
  detailMode: DetailMode;
  detailError: string;
  product: ProductDto | null;
  view: ProductView | null;
  version: string;
  /** 自动匹配到的平台（`defaultPlatform` 的结果）；不再由人选择，只用于签名与安装。 */
  platform: PlatformOption | null;
  install: InstallState;
};

function freshInstall(): InstallState {
  return { status: "idle", outcome: null, message: "", result: null, signed: null, pending: false };
}

function initialState(): State {
  return {
    query: "",
    channel: "stable",
    category: "",
    compatMode: "auto",
    // 首屏响应落地前没有生效口径：先按「只看可安装」展示，响应会立即纠正。
    appliedCompat: "compatible",
    loading: false,
    appending: false,
    catalogMode: "loading",
    errorText: "",
    appendError: "",
    items: [],
    total: 0,
    nextCursor: null,
    target: null,
    stale: false,
    fetchedAt: "",
    pageCompatibility: null,
    selectedSlug: "",
    detailMode: "idle",
    detailError: "",
    product: null,
    view: null,
    version: "",
    platform: null,
    install: freshInstall(),
  };
}

export function mount(target: HTMLElement, bridge: PageBridge): () => void {
  if (!target || typeof target.appendChild !== "function") return () => {};
  // 两个宿主动作各自 feature-detect：旧宿主只有 installExtension，新宿主还有
  // installAndEnableExtension（装完由宿主自己启用，回执带 outcome）。
  const canEnable = typeof bridge.installAndEnableExtension === "function";
  const canInstall = typeof bridge.installExtension === "function";
  /** 只要有一种安装方式，安装条就成立；否则退回签名链接。 */
  const canPageInstall = canInstall || canEnable;
  // Locale decides the copy table once, at mount; a missing or unknown value
  // falls back to zh-CN and never throws.
  const copy = createCopy(bridge?.locale);
  const state = initialState();
  // 连接商城：状态机与连接条都在 auth.ts，这里只把它插进壳里，并在它变化时重绘安装条。
  const auth = createAuthController({
    request: (path, options) => bridge.request(path, options),
    copy,
    onChange: () => refreshInstallArea(),
  });
  const disposers: Array<() => void> = [];
  let disposed = false;
  let catalogGeneration = 0;
  let detailGeneration = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // ---------- shell ----------

  const root = el("div", "sfstore");
  root.setAttribute("data-role", "root");
  root.setAttribute("lang", copy.locale);

  const searchInput = el("input", "sfstore__input") as HTMLInputElement;
  searchInput.type = "search";
  searchInput.placeholder = copy.t("searchPlaceholder");
  searchInput.autocomplete = "off";
  searchInput.setAttribute("data-role", "search");
  searchInput.setAttribute("aria-label", copy.t("searchAria"));

  const channelSelect = selectEl(channelOptions(copy), state.channel);
  channelSelect.setAttribute("data-role", "channel");
  channelSelect.setAttribute("aria-label", copy.t("channelAria"));

  const categorySelect = selectEl(categoryOptions(copy), state.category);
  categorySelect.setAttribute("data-role", "category");
  categorySelect.setAttribute("aria-label", copy.t("categoryAria"));

  const refreshButton = buttonEl(copy.t("refreshAction"));
  refreshButton.setAttribute("data-role", "refresh");

  // 兼容性开关：只在页级判决存在时出现。宿主没给版本（`unknown`）时后端本来就不按版本筛，
  // 开关按下去不会有任何变化，所以藏起来，由页级说明讲清楚（见 renderMeta）。
  const compatToggle = toggleEl(copy.t("compatOnlyAction"), {
    checked: state.appliedCompat === "compatible",
  });
  compatToggle.label.setAttribute("data-role", "compat-toggle");
  compatToggle.label.hidden = true;

  const toolbar = el("div", "sfstore__toolbar");
  toolbar.append(
    fieldEl(copy.t("searchField"), searchInput, "sfstore__field--search"),
    fieldEl(copy.t("channelField"), channelSelect),
    fieldEl(copy.t("categoryField"), categorySelect),
    compatToggle.label,
    refreshButton,
  );

  const countEl = el("p", "sfstore__count");
  countEl.setAttribute("data-role", "count");
  const staleEl = el("p", "sfstore__stale");
  staleEl.setAttribute("data-role", "stale");
  staleEl.hidden = true;
  // One sentence instead of a badge on every card: the host never reports its version, so
  // there is no per-card compatibility verdict to give (see compatibilityNote).
  const compatNoteEl = el("p", "sfstore__hint");
  compatNoteEl.setAttribute("data-role", "compat-note");
  compatNoteEl.hidden = true;
  const metaRow = el("div", "sfstore__meta");
  metaRow.append(countEl, staleEl, compatNoteEl);

  const head = el("header", "sfstore__head");
  head.append(toolbar, metaRow);

  const grid = el("div", "sfstore__grid");
  grid.setAttribute("data-role", "list");
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", copy.t("catalogAria"));

  // 卡片本身是按钮，逐张 announce 会很吵；加载态与结果数改由一个礼貌的 status 播报。
  const liveEl = el("p", "sfstore__sr-only");
  liveEl.setAttribute("role", "status");
  liveEl.setAttribute("data-role", "status");

  const moreErrorEl = el("p", "sfstore__error");
  moreErrorEl.setAttribute("data-role", "more-error");
  moreErrorEl.hidden = true;

  const moreButton = buttonEl(copy.t("loadMore"));
  moreButton.setAttribute("data-action", "load-more");
  moreButton.setAttribute("data-role", "more");

  const moreWrap = el("div", "sfstore__more");
  moreWrap.setAttribute("data-role", "more-wrap");
  moreWrap.hidden = true;
  moreWrap.append(moreErrorEl, moreButton);

  const results = el("div", "sfstore__results");
  results.append(liveEl, grid, moreWrap);

  root.append(head, auth.element, results);
  target.append(root);

  const dialog = createDialog({
    copy,
    background: root,
    onClose: () => {
      state.selectedSlug = "";
      state.detailMode = "idle";
      state.detailError = "";
      state.product = null;
      state.view = null;
      state.version = "";
      state.platform = null;
      state.install = freshInstall();
    },
  });

  // ---------- plumbing ----------

  function listen(node: EventTarget, type: string, handler: (event: any) => void) {
    node.addEventListener(type, handler);
    disposers.push(() => node.removeEventListener(type, handler));
  }

  function notify(title: string, description?: string, kind: "success" | "error" = "success") {
    if (typeof bridge.toast !== "function") return;
    try {
      bridge.toast(description ? { title, description, kind } : { title, kind });
    } catch {
      // toast 只是提示，失败不影响页面。
    }
  }

  async function goCore(path: string) {
    if (typeof bridge.navigate !== "function") return;
    try {
      await bridge.navigate(path);
    } catch {
      // 导航失败由宿主隔离；页面不重复报错。
    }
  }

  async function copyText(value: string): Promise<boolean> {
    const navigatorLike = (globalThis as any).navigator;
    try {
      if (navigatorLike?.clipboard?.writeText) {
        await navigatorLike.clipboard.writeText(value);
        return true;
      }
    } catch {
      // 非安全上下文或权限被拒：交给用户手动复制。
    }
    return false;
  }

  function findAttr(start: unknown, name: string, boundary: unknown): string {
    let current: any = start;
    while (current) {
      if (current.nodeType === 1 && typeof current.getAttribute === "function") {
        const value = current.getAttribute(name);
        if (value) return String(value);
      }
      if (current === boundary) break;
      current = current.parentNode;
    }
    return "";
  }

  // ---------- catalog ----------

  function resetPaging() {
    state.nextCursor = null;
    state.appendError = "";
  }

  function mergeItems(current: CatalogItemView[], incoming: CatalogItemView[]): CatalogItemView[] {
    const seen = new Set(current.map((item) => item.slug));
    const merged = current.slice();
    for (const item of incoming) {
      if (seen.has(item.slug)) continue;
      seen.add(item.slug);
      merged.push(item);
    }
    return merged;
  }

  async function loadCatalog(options: { append?: boolean; refresh?: boolean } = {}) {
    const append = options.append === true;
    if (append && (!state.nextCursor || state.appending || state.loading)) return;
    const generation = catalogGeneration += 1;
    state.loading = true;
    state.appendError = "";
    if (append) {
      state.appending = true;
    } else {
      state.items = [];
      state.catalogMode = "loading";
      state.errorText = "";
    }
    renderAll();

    try {
      const payload = await bridge.request(
        buildCatalogPath({
          query: state.query,
          channel: state.channel,
          category: state.category,
          cursor: append ? state.nextCursor : null,
          compatMode: state.compatMode,
          // 打开页面与点刷新要的是「现在」：60 秒新鲜窗口只留给搜索/筛选/翻页。
          refresh: options.refresh === true,
        }),
      );
      if (disposed || generation !== catalogGeneration) return;
      const document_ = parseCatalog(payload);
      // target 必须先落地：卡片徽标的架构判决要拿它当基准。
      const previousTarget = state.target;
      state.target = document_.target ?? null;
      // 只有 target 真的变了才重算详情：普通重载（搜索/翻页/刷新）不该把操作者
      // 手选的版本重置回默认。
      if (!sameTarget(previousTarget, state.target)) resyncDetailTarget();
      const incoming = document_.items.map((item) => toCatalogItemView(item, copy, state.target));
      state.items = append ? mergeItems(state.items, incoming) : incoming;
      state.total = document_.total;
      // parseCatalog 已经归一化过；这里把可空声明收紧成状态的真实形状。
      state.nextCursor = document_.nextCursor ?? null;
      state.stale = document_.stale === true;
      state.fetchedAt = document_.fetchedAt ?? "";
      state.pageCompatibility = document_.compatibility;
      // 服务端回显优先；老服务端不回显时只有 auto 才按 estimated 推断（见 resolveAppliedCompat）。
      state.appliedCompat = resolveAppliedCompat(document_, state.compatMode);
      state.catalogMode = state.items.length ? "ready" : "empty";
      state.errorText = "";
    } catch (error) {
      if (disposed || generation !== catalogGeneration) return;
      const failure = classifyFailure(error);
      if (append) {
        // 追加失败不动已有卡片：错误贴着「加载更多」，用户可以直接再点一次。
        state.appendError =
          failure.kind === "not_configured"
            ? copy.t("catalogUnreachable")
            : failure.detail || copy.t("catalogUnreachable");
      } else {
        state.items = [];
        state.total = 0;
        state.nextCursor = null;
        state.pageCompatibility = null;
        if (failure.kind === "not_configured") {
          state.catalogMode = "setup";
          state.errorText = "";
        } else {
          state.catalogMode = "error";
          state.errorText = failure.detail || copy.t("catalogUnreachable");
        }
      }
    } finally {
      if (!disposed && generation === catalogGeneration) {
        state.loading = false;
        state.appending = false;
        renderAll();
      }
    }
  }

  /**
   * 重读第一页。`refresh` 表示这次必须向商城复核：页面首屏、刷新按钮与错误重试
   * 都用它；搜索/筛选/翻页不传，交给插件后端的新鲜窗口。
   */
  function reloadCatalog(refresh = false) {
    resetPaging();
    void loadCatalog({ refresh });
  }

  // ---------- detail ----------

  // 详情一律强制复核（refresh 由调用方显式给出）：版本列表旧了，新版本就装不上。
  async function openProduct(slug: string, refresh: boolean) {
    if (!slug) return;
    const generation = detailGeneration += 1;
    state.selectedSlug = slug;
    state.detailMode = "loading";
    state.detailError = "";
    state.product = null;
    state.view = null;
    state.version = "";
    state.platform = null;
    state.install = freshInstall();
    dialog.open();
    dialog.activate("readme");
    renderDetail();

    try {
      // 详情永远要最新的版本列表：新发布的版本必须立刻可选、可装。
      const payload = await bridge.request(buildProductPath(slug, refresh));
      if (disposed || generation !== detailGeneration) return;
      const product = parseProduct(payload);
      const view = toProductView(product, copy, state.target);
      state.product = product;
      state.view = view;
      applyDetailSelection(view, product);
      state.detailMode = "ready";
    } catch (error) {
      if (disposed || generation !== detailGeneration) return;
      const failure = classifyFailure(error);
      if (failure.kind === "not_configured") {
        state.detailMode = "setup";
      } else {
        state.detailMode = "error";
        state.detailError = failure.detail || copy.t("detailUnavailable");
      }
      // 错误/未配置的说明只画在 README 分区，所以把焦点也带回默认分区。
      dialog.activate("readme");
    } finally {
      if (!disposed && generation === detailGeneration) renderDetail();
    }
  }

  // ---------- install ----------

  function currentRelease(): ReleaseView | null {
    if (!state.view) return null;
    return findRelease(state.view, state.version);
  }

  // 平台不再由人挑：换版本时按宿主 target 重新自动匹配（精确 → any/any → 第一项）。
  function syncPlatform() {
    state.platform = defaultPlatform(currentRelease(), state.target);
  }

  /**
   * 默认选「最新的、可安装的、支持当前架构」那一版；全都不支持时退到第一版，
   * 让安装门禁去说明「这一版装不上」，而不是留下一个空的下拉。
   *
   * 抽成函数是因为深链会让详情与目录并行：target 后到时必须用同一套规则重算，
   * 否则会沿用「还没有 target」时选中的第一项资产（多架构版本会因此装错平台）。
   */
  function applyDetailSelection(view: ProductView, product: ProductDto) {
    const versions = installableReleases(view);
    const preferred = preferredRelease(versions, state.target, product.latestVersion ?? "");
    const selected = preferred ?? versions[0] ?? null;
    state.version = selected?.version ?? "";
    state.platform = defaultPlatform(selected, state.target);
  }

  function sameTarget(left: PlatformDto | null, right: PlatformDto | null) {
    return (left?.os ?? "") === (right?.os ?? "") && (left?.arch ?? "") === (right?.arch ?? "");
  }

  /** 目录 target 后到（深链并行）时，按真实架构重算详情里的版本与安装平台。 */
  function resyncDetailTarget() {
    if (!state.product || !dialog.isOpen()) return;
    const view = toProductView(state.product, copy, state.target);
    state.view = view;
    applyDetailSelection(view, state.product);
  }

  async function requestSignedUrl(): Promise<InstallUrlResponseDto> {
    const product = state.product;
    if (!product || !state.version || !state.platform) throw new Error(copy.t("noInstallTarget"));
    const payload = await bridge.request(INSTALL_URL_PATH, {
      method: "POST",
      body: buildInstallUrlBody({
        slug: product.slug,
        version: state.version,
        os: state.platform.os,
        arch: state.platform.arch,
      }),
    });
    return parseInstallUrl(payload);
  }

  function signFailureMessage(failure: FailureClass): string {
    if (failure.kind === "not_configured") return copy.t("signNotConfigured");
    return failure.detail
      ? copy.t("signFailedWith", { detail: failure.detail })
      : copy.t("signFailed");
  }

  /**
   * 交给宿主安装。宿主有 `installAndEnableExtension` 就用它（装完由宿主按自己的规则启用，
   * 可执行后端仍要它自己的信任确认）；没有就退回只暂存的 `installExtension`。
   */
  function callInstall(request: HostInstallRequest) {
    return canEnable ? bridge.installAndEnableExtension!(request) : bridge.installExtension!(request);
  }

  /**
   * 回执状态只认宿主回报的 `outcome`。缺失或未知一律按「已暂存」处理：
   * 宁可少说，也不能把只暂存的包装成正在运行。
   */
  function receiptState(result: HostInstallResult): InstallState {
    const outcome = readInstallOutcome(result);
    const running = outcome === "enabled" || outcome === "upgraded";
    return {
      status: running ? "enabled" : "staged",
      outcome,
      message: "",
      result,
      signed: null,
      pending: false,
    };
  }

  function notifyReceipt(outcome: HostInstallEnableOutcome | null) {
    if (outcome === "enabled" || outcome === "upgraded") {
      notify(
        copy.t(outcome === "enabled" ? "enabledTitle" : "upgradedTitle"),
        copy.t(outcome === "enabled" ? "enabledNote" : "upgradedNote"),
        "success",
      );
      return;
    }
    notify(copy.t("stagedTitle"), trustNote(copy), "success");
  }

  /** 安装条主按钮在回执后的文案：宿主做完的事，不替它说成别的。 */
  function receiptLabel(): string | null {
    if (state.install.status === "enabled") {
      return copy.t(state.install.outcome === "upgraded" ? "upgradedTitle" : "enabledTitle");
    }
    // partial：包已在盘上，主按钮不能再是「安装并启用」（那等于整包重装）。
    if (state.install.status === "partial") return copy.t("partialTitle");
    return state.install.status === "staged" ? copy.t("stagedTitle") : null;
  }

  async function startInstall() {
    if (state.install.pending) {
      state.install.message = copy.t("installBusy");
      refreshInstallArea();
      notify(copy.t("installBusy"), copy.t("installBusyHint"), "error");
      return;
    }
    if (!canPageInstall || !state.product || !state.version || !state.platform) return;

    state.install = { ...freshInstall(), status: "running", pending: true };
    refreshInstallArea();

    let stage: "sign" | "install" = "sign";
    // 宿主回报「已在跑」时把详情让位：成功回执由宿主的弹窗讲，两层叠着只会互相遮。
    let closeOnReceipt = false;
    try {
      const signed = await requestSignedUrl();
      stage = "install";
      const result = await callInstall(
        buildInstallRequest({ signed, product: state.product, version: state.version }),
      );
      if (disposed) return;
      state.install = receiptState(result);
      closeOnReceipt = state.install.status === "enabled";
      notifyReceipt(state.install.outcome);
    } catch (error) {
      if (disposed) return;
      const failure = classifyFailure(error);
      const message = stage === "sign" ? signFailureMessage(failure) : installFailureText(error, copy);
      if (failure.phase === "activate") {
        // 装好了、只是没启用：如实说清楚，并且不给重装入口。
        // 回执里只放宿主的原始原因，别把通用码文案再贴一遍（回执本身已经说清了）。
        const detail = failure.detail && failure.detail !== "install_failed" ? failure.detail : "";
        state.install = { ...freshInstall(), status: "partial", message: detail };
        notify(copy.t("partialTitle"), copy.t("partialNote"), "error");
      } else {
        state.install = { ...freshInstall(), status: "failed", message };
        // 用户主动取消不是故障：只在 footer 状态位说明，不再弹一条不自动消失的错误 Toast。
        if (installFailureCode(error) !== "install_cancelled") notify(message, undefined, "error");
      }
    } finally {
      if (!disposed) {
        refreshInstallArea();
        // 先重绘再关：close() 会拒绝在 pending 状态下关闭，而 pending 只有
        // refreshInstallArea 里的 setPending 才会解除。暂存态不关 —— 回执里还有
        // 「去 core 启用」的交接入口。
        if (closeOnReceipt) dialog.close();
        restoreDialogFocus();
      }
    }
  }

  async function startSign() {
    if (state.install.pending) return;
    if (!state.product || !state.version || !state.platform) return;

    state.install = { ...freshInstall(), status: "running", pending: true };
    refreshInstallArea();

    try {
      const signed = await requestSignedUrl();
      if (disposed) return;
      state.install = { ...freshInstall(), status: "signed", signed };
      notify(copy.t("signedReadyTitle"), copy.t("signedValidHint"), "success");
    } catch (error) {
      if (disposed) return;
      const message = signFailureMessage(classifyFailure(error));
      state.install = { ...freshInstall(), status: "failed", message };
      notify(message, undefined, "error");
    } finally {
      if (!disposed) {
        refreshInstallArea();
        restoreDialogFocus();
      }
    }
  }

  async function copySignedUrl() {
    const url = state.install.signed?.url;
    if (!url) return;
    const copied = await copyText(url);
    notify(
      copied ? copy.t("copiedTitle") : copy.t("copyFailedTitle"),
      copied ? undefined : copy.t("copyFailedHint"),
      copied ? "success" : "error",
    );
  }

  // ---------- rendering ----------

  function renderAll() {
    renderMeta();
    renderList();
    renderMore();
    renderDetail();
  }

  function renderMeta() {
    if (state.catalogMode === "ready" || state.catalogMode === "empty") {
      countEl.textContent =
        state.total === 1 ? copy.t("resultCountOne") : copy.t("resultCount", { count: state.total });
    } else {
      countEl.textContent = "";
    }
    if (state.stale && state.fetchedAt) {
      staleEl.hidden = false;
      staleEl.textContent = copy.t("staleNotice", { time: formatDateTime(state.fetchedAt) });
    } else {
      staleEl.hidden = true;
      staleEl.textContent = "";
    }
    const note = compatibilityNote(state.pageCompatibility, copy, state.appliedCompat);
    compatNoteEl.hidden = note === "";
    compatNoteEl.textContent = note;

    // 开关只在有判决时存在；`checked` 跟**本次生效口径**走，而不是跟操作者的选择走 ——
    // 开发版宿主默认不过滤，这时开关必须是未勾的，否则开关在说谎。
    const showToggle =
      state.pageCompatibility !== null && state.pageCompatibility.status !== "unknown";
    compatToggle.label.hidden = !showToggle;
    compatToggle.input.checked = state.appliedCompat === "compatible";
  }

  function renderList() {
    grid.replaceChildren();
    liveEl.textContent = "";
    if (state.catalogMode === "loading") {
      for (const card of catalogSkeletonCards()) grid.append(card);
      liveEl.textContent = copy.t("catalogLoading");
      return;
    }
    if (state.catalogMode === "setup") {
      grid.append(
        stateBlock(copy, {
          title: copy.t("setupTitle"),
          text: copy.t("setupText"),
          action: { label: copy.t("recheckAction"), name: "reload" },
        }),
      );
      return;
    }
    if (state.catalogMode === "error") {
      grid.append(
        stateBlock(copy, {
          title: copy.t("catalogErrorTitle"),
          text: state.errorText,
          action: { label: copy.t("retryAction"), name: "reload" },
        }),
      );
      return;
    }
    if (!state.items.length) {
      grid.append(stateBlock(copy, { title: copy.t("emptyTitle"), text: copy.t("emptyText") }));
      return;
    }
    for (const item of state.items) grid.append(catalogCardView(item, copy));
  }

  function renderMore() {
    const visible = state.catalogMode === "ready" && (state.nextCursor !== null || state.appendError !== "");
    moreWrap.hidden = !visible;
    moreErrorEl.hidden = state.appendError === "";
    moreErrorEl.textContent = state.appendError;
    // 隐藏时也同步按钮态：下次重新可见时不能残留「加载中…」。
    moreButton.textContent = state.appending ? copy.t("loadMorePending") : copy.t("loadMore");
    moreButton.disabled = state.appending || state.loading;
    if (state.appending) moreButton.setAttribute("aria-busy", "true");
    else moreButton.removeAttribute("aria-busy");
  }

  function renderDetail() {
    if (!dialog.isOpen()) return;
    dialog.surface.setAttribute("aria-labelledby", DIALOG_TITLE_ID);
    dialog.header.replaceChildren();
    const view = state.view;
    const item = state.items.find((entry) => entry.slug === state.selectedSlug) ?? null;
    if (view) dialog.header.append(dialogHeaderFromView(view, copy));
    else if (item) dialog.header.append(dialogHeaderFromItem(item, copy));

    renderPanels();
    renderNotice();
    renderFoot();
  }

  function renderPanels() {
    const readmePanel = dialog.tab("readme").panel;
    const versionsPanel = dialog.tab("versions").panel;
    const notesPanel = dialog.tab("notes").panel;
    readmePanel.replaceChildren();
    versionsPanel.replaceChildren();
    notesPanel.replaceChildren();

    if (state.detailMode === "loading") {
      readmePanel.append(stateBlock(copy, { text: copy.t("detailLoading") }));
      return;
    }
    if (state.detailMode === "setup") {
      readmePanel.append(stateBlock(copy, { title: copy.t("setupTitle"), text: copy.t("setupText") }));
      return;
    }
    if (state.detailMode === "error") {
      readmePanel.append(
        stateBlock(copy, {
          title: copy.t("detailErrorTitle"),
          text: state.detailError,
          action: { label: copy.t("reloadAction"), name: "reload-detail" },
        }),
      );
      return;
    }
    const view = state.view;
    if (!view) return;
    // 作者条在最上方：打开弹窗默认就是 README，第一个看到的应该是「谁发的这个包」。
    if (view.author) readmePanel.append(authorStrip(view.author, copy));
    readmePanel.append(readmeBlock(view, copy));
    versionsPanel.append(versionsBlock(view, copy));
    notesPanel.append(notesBlock(view, copy));
  }

  function refreshInstallArea() {
    renderNotice();
    renderFoot();
  }

  /**
   * 安装条重绘会换掉原来的按钮节点：宿主的确认框把焦点还回来时已经没有落点，
   * `activeElement` 落到 body，Esc 就再也到不了 overlay 的 keydown。重绘后如果焦点
   * 不在弹窗内，就把它交回主按钮；主按钮此刻禁用（已暂存）则交给关闭按钮。
   * 测试替身没有 `contains`，按「不在弹窗内」处理，交给 focus() 记录即可。
   */
  function restoreDialogFocus() {
    if (!dialog.isOpen()) return;
    const doc = (globalThis as any).document;
    const active = doc?.activeElement ?? null;
    const inside = typeof dialog.surface.contains === "function" && dialog.surface.contains(active);
    if (inside) return;
    const primary = dialog.footer.querySelector(
      '[data-action="install"], [data-action="sign"]',
    ) as HTMLButtonElement | null;
    const target = primary && !primary.disabled
      ? primary
      : (dialog.surface.querySelector('[data-action="dialog-close"]') as HTMLElement | null);
    if (target && typeof target.focus === "function") target.focus();
  }

  /**
   * 滚动区内的通知槽：安装期间提示、旧宿主的签名链接、已暂存回执。
   * 放在滚动区而不是 footer：footer 高度恒 64px，任何状态都不增高。
   */
  /**
   * 架构说明：只在有 target 且详情已就绪时说。两种情形各一句 ——
   * 「最新版不支持、旧版支持」解释为什么默认选中了旧版本；「全都不支持」解释为什么装不了。
   * 选中的就是那个不支持的版本时这里不重复：安装门禁的状态位已经在说同一句话。
   */
  function platformNoticeText(): string {
    const view = state.view;
    if (!view || !state.target || state.detailMode !== "ready") return "";
    const platform = platformId(state.target);
    const installable = installableReleases(view);
    if (installable.length && installable.every((release) => release.supported === false)) {
      return copy.t("detailNoSupportedRelease", { platform });
    }
    const latest = view.releases.find((release) => release.version === view.latestVersion) ?? null;
    if (latest && latest.supported === false && state.version && state.version !== latest.version) {
      return copy.t("detailPlatformUnsupported", {
        version: latest.version,
        platform,
        selected: state.version,
      });
    }
    return "";
  }

  function renderNotice() {
    const slot = dialog.notice;
    slot.replaceChildren();
    if (!dialog.isOpen()) return;
    if (state.install.pending) {
      slot.append(el("p", "sfstore__notice", copy.t("installKeepPageOpen")));
    }
    const platformNotice = platformNoticeText();
    if (platformNotice) slot.append(el("p", "sfstore__notice", platformNotice));
    if (!canPageInstall) {
      slot.append(el("p", "sfstore__notice", copy.t("legacyHostNotice")));
      if (state.install.signed) slot.append(signedBlock(state.install.signed, copy));
    }
    // 点之前就说明「装完会由宿主启用」：按钮上的「安装并启用」不能是唯一提示。
    const view = state.view;
    const gate = view ? installGate(view, currentRelease(), state.target) : null;
    if (canEnable && gate?.installable && state.install.status === "idle" && !state.install.pending) {
      slot.append(el("p", "sfstore__notice", copy.t("installEnableHint")));
    }
    if (state.install.result && (state.install.status === "staged" || state.install.status === "enabled")) {
      slot.append(receiptBlock(state.install.result, copy, state.install.outcome));
    }
    if (state.install.status === "partial") {
      slot.append(partialBlock(state.install.message, copy));
    }
  }

  /** 状态位文案：安装流程自己的四种状态 + 空闲时的架构结论；门禁原因由 foot 在需要时补。 */
  function installStateText(gate: InstallGate, release: ReleaseView | null): string {
    if (state.install.pending) {
      if (!canPageInstall) return copy.t("signPendingAction");
      return copy.t(canEnable ? "installAndEnablePendingAction" : "installPendingAction");
    }
    if (state.install.status === "staged" && state.install.result) {
      return `${copy.t("stagedTitle")} · v${state.install.result.version}`;
    }
    if (state.install.status === "enabled" && state.install.result) {
      const title = copy.t(state.install.outcome === "upgraded" ? "upgradedTitle" : "enabledTitle");
      return `${title} · v${state.install.result.version}`;
    }
    if (state.install.status === "partial") return copy.t("partialTitle");
    if (state.install.status === "signed") return copy.t("signedReadyTitle");
    if (state.install.status === "failed") return state.install.message;
    // 空闲且能装：把「这台服务器跑得起来」直接说出来。架构不再由人挑，结论就得有人讲。
    if (gate.installable && release?.supported === true && state.target) {
      return copy.t("platformSupportedState", { platform: platformId(state.target) });
    }
    return "";
  }

  function installStateTone(gate: InstallGate, release: ReleaseView | null): "" | "ok" | "bad" {
    if (state.install.pending) return "";
    if (state.install.status === "staged" || state.install.status === "enabled") return "ok";
    if (state.install.status === "signed") return "ok";
    if (state.install.status === "failed") return "bad";
    if (state.install.status === "partial") return "bad";
    if (gate.installable && release?.supported === true && state.target) return "ok";
    return "";
  }

  /** 只重绘弹窗底部：版本/状态位/主按钮，四态同一行，高度恒 64px。 */
  function renderFoot() {
    const foot = dialog.footer;
    foot.replaceChildren();
    // 安装期间关闭按钮禁用，Esc 与遮罩点击由 dialog 自己忽略。
    dialog.setPending(state.install.pending);
    if (!dialog.isOpen()) return;
    const view = state.view;
    const product = state.product;
    if (!view || !product || state.detailMode !== "ready") return;

    const release = currentRelease();
    const gate = installGate(view, release, state.target);
    foot.append(
      ...footNodes(
        {
          releases: installableReleases(view),
          version: state.version,
          target: state.target,
          gate,
          gateText: installGateText(gate, release, copy, state.target),
          canInstall: canPageInstall,
          canEnable,
          pending: state.install.pending,
          receiptLabel: receiptLabel(),
          stateText: installStateText(gate, release),
          tone: installStateTone(gate, release),
          authBlocked: auth.isBlocking(),
          authWaiting: auth.snapshot().phase === "waiting",
        },
        copy,
      ),
    );
  }

  // ---------- wiring ----------

  listen(searchInput, "input", () => {
    state.query = searchInput.value;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (disposed) return;
      reloadCatalog();
    }, SEARCH_DEBOUNCE_MS);
  });

  listen(channelSelect, "change", () => {
    state.channel = channelSelect.value === "all" ? "all" : "stable";
    reloadCatalog();
  });

  listen(categorySelect, "change", () => {
    state.category = categorySelect.value;
    reloadCatalog();
  });

  listen(compatToggle.input, "change", () => {
    // 勾上 = 只看当前版本能装的（显式 compatible）；取消 = 全部（显式 all）。
    // 两种都是操作者的显式选择，必须发出去 —— 服务端默认值随宿主变化，省略会变成另一个口径。
    const next: AppliedCompat = compatToggle.input.checked ? "compatible" : "all";
    state.compatMode = next;
    // 显式口径在请求飞行期间就是页面的结论：先记下来，重绘时开关与说明不会跳回旧值。
    state.appliedCompat = next;
    // 兼容性口径变了，旧游标指向的是一份不同的结果集：回到第一页重来。
    reloadCatalog();
  });

  // 刷新是操作者的显式动作：一定向商城复核，不能只是重复一次同键查询。
  listen(refreshButton, "click", () => reloadCatalog(true));

  listen(moreButton, "click", () => {
    void loadCatalog({ append: true });
  });

  listen(grid, "click", (event: any) => {
    const action = findAttr(event.target, "data-action", grid);
    if (action === "reload") {
      reloadCatalog(true);
      return;
    }
    const slug = findAttr(event.target, "data-slug", grid);
    if (slug) void openProduct(slug, true);
  });

  listen(dialog.surface, "click", (event: any) => {
    const action = findAttr(event.target, "data-action", dialog.surface);
    if (!action) return;
    if (action === "install") void startInstall();
    // 「登录后安装」：弹窗盖住了目录顶部的连接条，这枚按钮就是连接入口。
    else if (action === "auth-connect") void auth.connect();
    else if (action === "sign") void startSign();
    else if (action === "copy") void copySignedUrl();
    else if (action === "open-core-install") void goCore(CORE_INSTALL_PATH);
    else if (action === "open-core") void goCore(corePathForKind(state.install.result?.type ?? productKind()));
    else if (action === "reload-detail") void openProduct(state.selectedSlug, true);
  });

  listen(dialog.surface, "change", (event: any) => {
    const action = findAttr(event.target, "data-action", dialog.surface);
    const select = event.target as HTMLSelectElement;
    if (action === "version") {
      state.version = select.value;
      syncPlatform();
      // 换了版本，上一份回执或签名链接就不再对应：回到 idle，主按钮重新可用。
      state.install = freshInstall();
      refreshInstallArea();
      focusFootSelect("version");
    }
  });

  /** footer 重绘后把焦点还给刚操作过的 select（键盘选择不该把焦点丢掉）。 */
  function focusFootSelect(action: string) {
    const node = dialog.footer.querySelector(`select[data-action="${action}"]`) as HTMLSelectElement | null;
    if (node && typeof node.focus === "function") node.focus();
  }

  function productKind(): Kind {
    return state.product?.kind ?? state.view?.kind ?? "plugin";
  }

  renderAll();
  // 首屏必须向商城复核：新鲜窗口内的快照会让刚发布的扩展「打开页面看不见」。
  void loadCatalog({ refresh: true });
  void auth.load();
  // 深链：`?product=<slug>` 首次挂载就打开详情，和目录请求并行、互不等待。
  // 目录落地后 state.target 会补齐，renderAll() 会让详情按真实架构重绘。
  const deepLinkSlug = readProductQuery(globalThis.location?.search ?? "");
  if (deepLinkSlug) void openProduct(deepLinkSlug, true);

  return () => {
    disposed = true;
    catalogGeneration += 1;
    detailGeneration += 1;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    for (const dispose of disposers.splice(0)) dispose();
    auth.destroy();
    dialog.destroy();
    root.remove();
  };
}
