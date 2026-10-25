// SForum 应用商城管理页（Admin Micro-frontend API v1，预构建 ESM）。
//
// 约束（见 AGENTS.md 与 knowledge/plans/2026-10-24-app-store-service.md §7.5）：
// - 只通过 `bridge.request` 访问插件自己的三条路由，不主动发跨域请求、不加载外部字体。
//   产品图标是商城的内容寻址资产，由插件后端拼成绝对地址、浏览器直连商城：
//   `<img>` 加载失败就退回字母块，绝不显示破图。README 由商城渲染并消毒后整体注入，
//   其中的图片属于 README 内容本身（GitHub 托管）。
// - 安装只走宿主页面动作 `bridge.installExtension`，成功语义是「已暂存」；启用与信任在 core 完成。
// - 手写 ESM 拿不到 Host 图标运行时：所有按钮用文字，不用 emoji、不手绘内联 SVG。

import { createCopy } from "./copy";
import { buttonEl, el, fieldEl, selectEl, toggleEl } from "./dom";
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
  installFailureText,
  installableReleases,
  parseCatalog,
  parseInstallUrl,
  parseProduct,
  toCatalogItemView,
  toProductView,
} from "./logic";
import type { ChannelChoice, CompatMode, FailureClass } from "./logic";
import {
  catalogRowView,
  detailHeader,
  notesBlock,
  readmeBlock,
  signedBlock,
  stagedBlock,
  stateBlock,
  trustNote,
  versionsBlock,
} from "./view";
import type {
  CatalogItemView,
  CompatibilityDto,
  HostInstallResult,
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
type InstallStatus = "idle" | "running" | "staged" | "failed" | "signed";

type InstallState = {
  status: InstallStatus;
  message: string;
  result: HostInstallResult | null;
  signed: InstallUrlResponseDto | null;
  pending: boolean;
};

type State = {
  query: string;
  channel: ChannelChoice;
  category: string;
  /** 兼容性口径：默认只看能装的；`all` 才向路由追加 `compat=all`。 */
  compatMode: CompatMode;
  page: number;
  trail: Array<string | null>;
  loading: boolean;
  catalogMode: CatalogMode;
  errorText: string;
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
  platform: PlatformOption | null;
  install: InstallState;
};

function freshInstall(): InstallState {
  return { status: "idle", message: "", result: null, signed: null, pending: false };
}

function initialState(): State {
  return {
    query: "",
    channel: "stable",
    category: "",
    compatMode: "compatible",
    page: 0,
    trail: [null],
    loading: false,
    catalogMode: "loading",
    errorText: "",
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
  const canInstall = typeof bridge.installExtension === "function";
  // Locale decides the copy table once, at mount; a missing or unknown value
  // falls back to zh-CN and never throws.
  const copy = createCopy(bridge?.locale);
  const state = initialState();
  const disposers: Array<() => void> = [];
  let disposed = false;
  let catalogGeneration = 0;
  let detailGeneration = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let installBlock: HTMLElement | null = null;

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
    checked: state.compatMode === "compatible",
  });
  compatToggle.label.setAttribute("data-role", "compat-toggle");
  compatToggle.label.hidden = true;

  const filters = el("div", "sfstore__filters");
  filters.append(
    fieldEl(copy.t("searchField"), searchInput),
    fieldEl(copy.t("channelField"), channelSelect),
    fieldEl(copy.t("categoryField"), categorySelect),
  );

  const intro = el("div", "sfstore__intro");
  intro.append(
    el("h2", "sfstore__title", copy.t("pageTitle")),
    el("p", "sfstore__lede", copy.t("pageLede")),
  );

  const head = el("header", "sfstore__head");
  head.append(intro, filters);

  const countEl = el("p", "sfstore__count");
  countEl.setAttribute("data-role", "count");
  const staleEl = el("p", "sfstore__stale");
  staleEl.setAttribute("data-role", "stale");
  staleEl.hidden = true;
  // One sentence instead of a badge on every row: the host never reports its version, so
  // there is no per-row compatibility verdict to give (see compatibilityNote).
  const compatNoteEl = el("p", "sfstore__hint");
  compatNoteEl.setAttribute("data-role", "compat-note");
  compatNoteEl.hidden = true;
  const metaRow = el("div", "sfstore__meta");
  metaRow.append(countEl, compatToggle.label, staleEl, compatNoteEl);

  const listEl = el("div", "sfstore__list");
  listEl.setAttribute("data-role", "list");
  listEl.setAttribute("aria-live", "polite");

  const prevButton = buttonEl(copy.t("prevPage"));
  prevButton.setAttribute("data-role", "prev");
  const nextButton = buttonEl(copy.t("nextPage"));
  nextButton.setAttribute("data-role", "next");
  const pager = el("div", "sfstore__pager");
  pager.append(prevButton, nextButton);

  const listHead = el("div", "sfstore__panel-head");
  listHead.append(el("h3", "sfstore__panel-title", copy.t("catalogHeading")), refreshButton);

  const listPanel = el("section", "sfstore__panel");
  listPanel.setAttribute("aria-label", copy.t("catalogAria"));
  listPanel.append(listHead, listEl, pager);

  const detailEl = el("div", "sfstore__detail");
  detailEl.setAttribute("data-role", "detail");
  const detailPanel = el("section", "sfstore__panel sfstore__panel--detail");
  detailPanel.setAttribute("aria-label", copy.t("detailAria"));
  detailPanel.append(detailEl);

  const grid = el("div", "sfstore__grid");
  grid.append(listPanel, detailPanel);

  root.append(head, metaRow, grid);
  target.append(root);

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
    state.trail = [null];
    state.page = 0;
    state.nextCursor = null;
  }

  async function loadCatalog() {
    const generation = catalogGeneration += 1;
    state.loading = true;
    if (!state.items.length) state.catalogMode = "loading";
    renderAll();

    try {
      const payload = await bridge.request(
        buildCatalogPath({
          query: state.query,
          channel: state.channel,
          category: state.category,
          cursor: state.trail[state.page] ?? null,
          compatMode: state.compatMode,
        }),
      );
      if (disposed || generation !== catalogGeneration) return;
      const document_ = parseCatalog(payload);
      state.items = document_.items.map((item) => toCatalogItemView(item, copy));
      state.total = document_.total;
      // parseCatalog 已经归一化过；这里把可空声明收紧成状态的真实形状。
      state.nextCursor = document_.nextCursor ?? null;
      state.target = document_.target ?? null;
      state.stale = document_.stale === true;
      state.fetchedAt = document_.fetchedAt ?? "";
      state.pageCompatibility = document_.compatibility;
      state.catalogMode = state.items.length ? "ready" : "empty";
      state.errorText = "";
    } catch (error) {
      if (disposed || generation !== catalogGeneration) return;
      const failure = classifyFailure(error);
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
    } finally {
      if (!disposed && generation === catalogGeneration) {
        state.loading = false;
        renderAll();
      }
    }
  }

  function goPage(delta: number) {
    if (state.loading) return;
    if (delta < 0) {
      if (state.page === 0) return;
      state.page -= 1;
    } else {
      if (!state.nextCursor) return;
      state.trail = state.trail.slice(0, state.page + 1);
      state.trail.push(state.nextCursor);
      state.page += 1;
    }
    void loadCatalog();
  }

  // ---------- detail ----------

  async function selectDetail(slug: string) {
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
    renderAll();

    try {
      const payload = await bridge.request(buildProductPath(slug));
      if (disposed || generation !== detailGeneration) return;
      const product = parseProduct(payload);
      const view = toProductView(product, copy);
      state.product = product;
      state.view = view;
      const versions = installableReleases(view);
      const preferred = product.latestVersion && versions.some((item) => item.version === product.latestVersion)
        ? product.latestVersion
        : versions[0]?.version ?? "";
      state.version = preferred;
      state.platform = defaultPlatform(findRelease(view, preferred), state.target);
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
    } finally {
      if (!disposed && generation === detailGeneration) renderAll();
    }
  }

  // ---------- install ----------

  function currentRelease(): ReleaseView | null {
    if (!state.view) return null;
    return findRelease(state.view, state.version);
  }

  function syncPlatform() {
    const release = currentRelease();
    if (!release) {
      state.platform = null;
      return;
    }
    const kept = state.platform
      ? release.platforms.find((item) => item.os === state.platform?.os && item.arch === state.platform?.arch)
      : undefined;
    state.platform = kept ?? defaultPlatform(release, state.target);
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

  async function startInstall() {
    if (state.install.pending) {
      state.install.message = copy.t("installBusy");
      refreshInstallArea();
      notify(copy.t("installBusy"), copy.t("installBusyHint"), "error");
      return;
    }
    if (!canInstall || !state.product || !state.version || !state.platform) return;

    state.install = { status: "running", message: "", result: null, signed: null, pending: true };
    refreshInstallArea();

    let stage: "sign" | "install" = "sign";
    try {
      const signed = await requestSignedUrl();
      stage = "install";
      const result = await bridge.installExtension!(
        buildInstallRequest({ signed, product: state.product, version: state.version }),
      );
      if (disposed) return;
      state.install = { status: "staged", message: "", result, signed: null, pending: false };
      notify(copy.t("stagedTitle"), trustNote(copy), "success");
    } catch (error) {
      if (disposed) return;
      const failure = classifyFailure(error);
      const message = stage === "sign" ? signFailureMessage(failure) : installFailureText(error, copy);
      state.install = { status: "failed", message, result: null, signed: null, pending: false };
      notify(message, undefined, "error");
    } finally {
      if (!disposed) refreshInstallArea();
    }
  }

  async function startSign() {
    if (state.install.pending) return;
    if (!state.product || !state.version || !state.platform) return;

    state.install = { status: "running", message: "", result: null, signed: null, pending: true };
    refreshInstallArea();

    try {
      const signed = await requestSignedUrl();
      if (disposed) return;
      state.install = { status: "signed", message: "", result: null, signed, pending: false };
      notify(copy.t("signedReadyTitle"), copy.t("signedValidHint"), "success");
    } catch (error) {
      if (disposed) return;
      const message = signFailureMessage(classifyFailure(error));
      state.install = { status: "failed", message, result: null, signed: null, pending: false };
      notify(message, undefined, "error");
    } finally {
      if (!disposed) refreshInstallArea();
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
    renderPager();
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
    const note = compatibilityNote(state.pageCompatibility, copy, state.compatMode);
    compatNoteEl.hidden = note === "";
    compatNoteEl.textContent = note;

    // 开关只在有判决时存在；`checked` 始终跟状态走，避免重新渲染后与请求口径脱节。
    const showToggle =
      state.pageCompatibility !== null && state.pageCompatibility.status !== "unknown";
    compatToggle.label.hidden = !showToggle;
    compatToggle.input.checked = state.compatMode === "compatible";
  }

  function renderList() {
    listEl.replaceChildren();
    if (state.catalogMode === "loading") {
      listEl.append(stateBlock(copy, { text: copy.t("catalogLoading") }));
      return;
    }
    if (state.catalogMode === "setup") {
      listEl.append(
        stateBlock(copy, {
          title: copy.t("setupTitle"),
          text: copy.t("setupText"),
          action: { label: copy.t("recheckAction"), name: "reload" },
        }),
      );
      return;
    }
    if (state.catalogMode === "error") {
      listEl.append(
        stateBlock(copy, {
          title: copy.t("catalogErrorTitle"),
          text: state.errorText,
          action: { label: copy.t("retryAction"), name: "reload" },
        }),
      );
      return;
    }
    if (!state.items.length) {
      listEl.append(
        stateBlock(copy, { title: copy.t("emptyTitle"), text: copy.t("emptyText") }),
      );
      return;
    }
    for (const item of state.items) listEl.append(catalogRowView(item, item.slug === state.selectedSlug));
  }

  function renderPager() {
    prevButton.disabled = state.loading || state.page === 0;
    nextButton.disabled = state.loading || !state.nextCursor;
  }

  function renderDetail() {
    installBlock = null;
    detailEl.replaceChildren();
    if (state.detailMode === "idle") {
      detailEl.append(stateBlock(copy, { text: copy.t("detailIdle") }));
      return;
    }
    if (state.detailMode === "loading") {
      detailEl.append(stateBlock(copy, { text: copy.t("detailLoading") }));
      return;
    }
    if (state.detailMode === "setup") {
      detailEl.append(
        stateBlock(copy, {
          title: copy.t("setupTitle"),
          text: copy.t("setupText"),
        }),
      );
      return;
    }
    if (state.detailMode === "error") {
      detailEl.append(
        stateBlock(copy, {
          title: copy.t("detailErrorTitle"),
          text: state.detailError,
          action: { label: copy.t("reloadAction"), name: "reload-detail" },
        }),
      );
      return;
    }
    const view = state.view;
    const product = state.product;
    if (!view || !product) {
      detailEl.append(stateBlock(copy, { text: copy.t("detailNoSelection") }));
      return;
    }

    detailEl.append(detailHeader(view, copy));
    installBlock = el("div", "sfstore__install");
    installBlock.setAttribute("data-role", "install");
    detailEl.append(installBlock);
    renderInstallArea();

    const notes = notesBlock(view, state.version, copy);
    if (notes) detailEl.append(notes);
    detailEl.append(readmeBlock(view, copy));
    detailEl.append(versionsBlock(view, copy));
  }

  function refreshInstallArea() {
    if (!installBlock) return;
    renderInstallArea();
  }

  function renderInstallArea() {
    if (!installBlock) return;
    installBlock.replaceChildren();
    const view = state.view;
    const product = state.product;
    if (!view || !product) return;

    const versions = installableReleases(view);
    if (!versions.length) {
      installBlock.append(el("p", "sfstore__notice", copy.t("noInstallableVersion")));
      return;
    }

    const versionSelect = selectEl(
      versions.map((release) => ({
        value: release.version,
        label: copy.t("versionOption", { version: release.version, channel: release.channelLabel }),
      })),
      state.version,
    );
    versionSelect.setAttribute("data-action", "version");
    versionSelect.setAttribute("aria-label", copy.t("versionSelectAria"));

    const platformSelect = selectEl(
      (currentRelease()?.platforms ?? []).map((option) => ({ value: `${option.os}/${option.arch}`, label: option.label })),
      state.platform ? `${state.platform.os}/${state.platform.arch}` : undefined,
    );
    platformSelect.setAttribute("data-action", "platform");
    platformSelect.setAttribute("aria-label", copy.t("platformSelectAria"));

    const selectors = el("div", "sfstore__install-row");
    selectors.append(
      fieldEl(copy.t("labelVersion"), versionSelect),
      fieldEl(copy.t("labelPlatform"), platformSelect),
    );
    installBlock.append(selectors);

    if (!canInstall) {
      renderSignedInstall();
    } else {
      renderHostInstall();
    }

    if (state.install.message && state.install.status !== "staged") {
      installBlock.append(el("p", "sfstore__error", state.install.message));
    }
  }

  function renderHostInstall() {
    const installButton = buttonEl(
      state.install.pending ? copy.t("installPendingAction") : copy.t("installAction"),
      "primary",
    );
    installButton.setAttribute("data-action", "install");
    installButton.disabled = state.install.pending;
    installBlock?.append(installButton);

    if (state.install.pending) {
      installBlock?.append(el("p", "sfstore__notice", copy.t("installKeepPageOpen")));
    }
    if (state.install.status === "staged" && state.install.result) {
      installBlock?.append(stagedBlock(state.install.result, copy));
    }
  }

  function renderSignedInstall() {
    installBlock?.append(el("p", "sfstore__notice", copy.t("legacyHostNotice")));

    const signButton = buttonEl(
      state.install.pending ? copy.t("signPendingAction") : copy.t("signAction"),
      "primary",
    );
    signButton.setAttribute("data-action", "sign");
    signButton.disabled = state.install.pending;
    installBlock?.append(signButton);

    if (state.install.signed) installBlock?.append(signedBlock(state.install.signed, copy));
  }

  listen(searchInput, "input", () => {
    state.query = searchInput.value;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (disposed) return;
      resetPaging();
      void loadCatalog();
    }, SEARCH_DEBOUNCE_MS);
  });

  listen(channelSelect, "change", () => {
    state.channel = channelSelect.value === "all" ? "all" : "stable";
    resetPaging();
    void loadCatalog();
  });

  listen(categorySelect, "change", () => {
    state.category = categorySelect.value;
    resetPaging();
    void loadCatalog();
  });

  listen(compatToggle.input, "change", () => {
    // 勾上 = 只看当前版本能装的（后端默认）；取消 = 全部，显式发 compat=all。
    state.compatMode = compatToggle.input.checked ? "compatible" : "all";
    // 兼容性口径变了，旧游标指向的是一份不同的结果集：回到第一页重来。
    resetPaging();
    void loadCatalog();
  });

  listen(refreshButton, "click", () => {
    resetPaging();
    void loadCatalog();
  });

  listen(prevButton, "click", () => goPage(-1));
  listen(nextButton, "click", () => goPage(1));

  listen(listEl, "click", (event: any) => {
    const action = findAttr(event.target, "data-action", listEl);
    if (action === "reload") {
      resetPaging();
      void loadCatalog();
      return;
    }
    const slug = findAttr(event.target, "data-slug", listEl);
    if (slug && slug !== state.selectedSlug) void selectDetail(slug);
  });

  listen(detailPanel, "click", (event: any) => {
    const action = findAttr(event.target, "data-action", detailPanel);
    if (!action) return;
    if (action === "install") void startInstall();
    else if (action === "sign") void startSign();
    else if (action === "copy") void copySignedUrl();
    else if (action === "open-core-install") void goCore(CORE_INSTALL_PATH);
    else if (action === "open-core") void goCore(corePathForKind(state.install.result?.type ?? productKind()));
    else if (action === "reload-detail") void selectDetail(state.selectedSlug);
  });

  listen(detailPanel, "change", (event: any) => {
    const action = findAttr(event.target, "data-action", detailPanel);
    const target = event.target as HTMLSelectElement;
    if (action === "version") {
      state.version = target.value;
      syncPlatform();
      refreshInstallArea();
      return;
    }
    if (action === "platform") {
      const release = currentRelease();
      const [os, arch] = String(target.value).split("/");
      const option = release?.platforms.find((item) => item.os === os && item.arch === arch);
      state.platform = option ?? null;
      refreshInstallArea();
    }
  });

  function productKind(): Kind {
    return state.product?.kind ?? state.view?.kind ?? "plugin";
  }

  renderAll();
  void loadCatalog();

  return () => {
    disposed = true;
    catalogGeneration += 1;
    detailGeneration += 1;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    for (const dispose of disposers.splice(0)) dispose();
    root.remove();
  };
}
