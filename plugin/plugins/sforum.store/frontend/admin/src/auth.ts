// 「连接商城」的页面侧：状态机 + 连接条。
//
// 商城在 `download_auth_mode=account_required` 时要求账号令牌；令牌由**插件后端**持有
// （写在宿主加密的 secret 设置里），页面只负责把操作者带到商城的授权页，然后轮询结果。
// 页面从不接触令牌，也从不把它放进 URL 或 localStorage。
//
// 两条硬约束：
// 1. `window.open` 必须在任何 await 之前同步调用 —— 否则弹窗拦截器会把这次打开当成
//    非用户手势。所以先开一个 about:blank，拿到 authorizeUrl 之后再导航它。
// 2. 轮询有截止时间：授权请求本身只有 5 分钟，页面不能无限转圈。

import { buttonEl, el } from "./dom";
import type { Copy } from "./copy";
import { formatDateTime, readFailure } from "./logic";

export const AUTH_STATUS_PATH = "/api/store/auth/status";
export const AUTH_START_PATH = "/api/store/auth/start";
export const AUTH_POLL_PATH = "/api/store/auth/poll";
export const AUTH_DISCONNECT_PATH = "/api/store/auth/disconnect";

/** 商城模式。`unsupported` 是插件的说法：旧商城没有 /api/v1/auth/mode。 */
export type AuthMode = "anonymous" | "account_required" | "unsupported";

export type AuthPhase =
  | "loading"
  | "idle"
  | "connecting"
  | "waiting"
  | "connected"
  | "error";

export type AuthAccount = {
  id: string;
  issuerKey: string;
  username: string;
  displayName: string;
  avatarUrl: string;
};

export type AuthSnapshot = {
  phase: AuthPhase;
  mode: AuthMode;
  connected: boolean;
  account: AuthAccount | null;
  expiresAt: string | null;
  /** 等待授权时显示的短码，和商城授权页上的那一串对照。 */
  code: string;
  message: string;
  /** 等待期间连续重试了几次（临时失败不清零，成功一拍才清零）。 */
  retries: number;
  /** 最近一次临时失败的短因（HTTP 状态或错误码），用来在连接条上说清楚。 */
  lastFailure: string;
};

/**
 * 新标签句柄：导航用 `location.href`，失败时用 `document` 把原因写进那个标签页，
 * 最后用 `close`（可选）。`document` 在真实浏览器里是 about:blank 的文档（与 opener 同源），
 * 测试替身里可以没有。
 */
export type AuthTab = {
  location: { href: string };
  close?: () => void;
  document?: {
    title?: string;
    body?: { textContent?: string } | null;
    documentElement?: { textContent?: string } | null;
  } | null;
} | null;

export type AuthDeps = {
  request: <T = unknown>(path: string, options?: Record<string, unknown>) => Promise<T>;
  copy: Copy;
  /** 同步开窗；默认 `window.open("about:blank", "_blank")` 并置 opener=null。 */
  openWindow?: () => AuthTab;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
  /** 每次状态变化后调用：页面据此重绘安装条。 */
  onChange?: (snapshot: AuthSnapshot) => void;
};

const DEFAULT_INTERVAL_SECONDS = 2;
// 商城的 `install-auth-poll` 有 2 秒下限（1 次/2 秒），按 1 秒轮询会稳定吃 429，
// 而 429 又会被插件包成 502 —— 于是「轮询」变成「连接失败」。下限与商城对齐。
const MIN_INTERVAL_SECONDS = 2;
const DEFAULT_EXPIRES_IN_SECONDS = 300;

function emptySnapshot(): AuthSnapshot {
  return {
    phase: "loading",
    mode: "anonymous",
    connected: false,
    account: null,
    expiresAt: null,
    code: "",
    message: "",
    retries: 0,
    lastFailure: "",
  };
}

function defaultOpenWindow(): AuthTab {
  const scope = globalThis as any;
  const win = scope?.window ?? scope;
  if (typeof win?.open !== "function") return null;
  const tab = win.open("about:blank", "_blank");
  if (tab) {
    // 授权页不该能通过 window.opener 反向操作这个管理页。
    try {
      tab.opener = null;
    } catch {
      // 某些浏览器下 opener 只读；忽略即可，导航仍然有效。
    }
  }
  return tab;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readAccount(value: unknown): AuthAccount | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = readString(record.id);
  if (!id) return null;
  return {
    id,
    issuerKey: readString(record.issuerKey),
    username: readString(record.username),
    displayName: readString(record.displayName),
    avatarUrl: readString(record.avatarUrl),
  };
}

function readMode(value: unknown): AuthMode {
  return value === "account_required" || value === "unsupported" ? value : "anonymous";
}

/**
 * 商城/插件/宿主给的失败 → 页面文案。
 *
 * 三条来源的错误形状不一样，`readFailure` 是唯一解析器：插件的裸 JSON 文档、宿主的
 * `{code, message, data}` 信封、以及 fetch 的 HTTP 错误。只看 `error.data.code`
 * 会把「插件正在重启（宿主 503）」读成空码，最后落到一句什么都没说的通用失败。
 */
export function authErrorMessage(
  code: string,
  copy: Copy,
  detail?: string,
  status = 0,
): string {
  switch (code) {
    case "not_configured":
      return copy.t("authNotConfigured");
    case "auth_unsupported":
      return copy.t("authUnsupported");
    case "auth_not_required":
      return copy.t("authNotRequired");
    case "request_unknown":
      return copy.t("authRequestUnknown");
    case "secret_write_failed":
      return copy.t("authSecretWriteFailed");
    case "login_required":
      return copy.t("authLoginRequired");
  }
  // 没有插件错误码时按 HTTP 状态说人话：这一层几乎总是「宿主/商城暂时不可用」。
  if (status === 429) return copy.t("authSlowDown");
  if (status === 403) return copy.t("authForbidden");
  if (status >= 500) return copy.t("authHostUnavailable");
  return detail ? copy.t("authFailedWith", { detail }) : copy.t("authFailed");
}

/** 一次失败的三元组：稳定码、HTTP 状态、可读 detail。 */
function failureOf(error: unknown): { code: string; status: number; detail: string } {
  const failure = readFailure(error);
  return {
    code: failure.code,
    status: failure.status,
    detail: failure.detail ?? "",
  };
}

/**
 * 这次轮询失败值不值得再试。
 *
 * 值得：传输错误（没有状态码）、429、5xx、以及插件自己的 `upstream_error`
 * ——它们都表示「这一拍没拿到答案」，商城那边的授权请求还活着。
 * 不值得：`request_unknown`（插件重启过，verifier 没了）、`secret_write_failed`、
 * 以及任何 4xx —— 重试不会变。
 */
export function isTransientPollFailure(code: string, status: number): boolean {
  // 确定性失败优先：`secret_write_failed` 也是 5xx，但重试一万次也写不进去；
  // `request_unknown` 说明插件重启过、verifier 已经没了。
  if (code === "request_unknown" || code === "secret_write_failed") return false;
  // 宿主级 404（信封里没有插件的字符串码）= 路由此刻没注册上 —— 插件正在重新装配。
  // 这正是「等一会儿就好」的那一类，不能当终局。插件自己的 404 一定带字符串码。
  if (status === 404 && code === "") return true;
  if (status === 0 || status === 429 || status >= 500) return true;
  return code === "upstream_error" || code === "slow_down";
}

function authMessageFor(error: unknown, copy: Copy): string {
  const { code, status, detail } = failureOf(error);
  return authErrorMessage(code, copy, detail, status);
}

export type AuthController = {
  /** 连接条节点：由控制器自己重绘，页面只负责插进壳里。 */
  element: HTMLElement;
  snapshot: () => AuthSnapshot;
  /** 商城要求登录且当前没有可用凭据：安装必须被挡住。 */
  isBlocking: () => boolean;
  load: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  destroy: () => void;
};

export function createAuthController(deps: AuthDeps): AuthController {
  const copy = deps.copy;
  const openWindow = deps.openWindow ?? defaultOpenWindow;
  const setTimer =
    deps.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms) as unknown);
  const clearTimer =
    deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = deps.now ?? (() => Date.now());

  let state = emptySnapshot();
  let pollHandle: unknown = null;
  let deadline = 0;
  let requestId = "";
  /** 商城在 /auth/start 里给的轮询间隔；后续每一轮都用它，不再回落到下限。 */
  let pollIntervalSeconds = DEFAULT_INTERVAL_SECONDS;
  let disposed = false;

  const element = el("section", "sfstore__auth");
  element.setAttribute("data-role", "auth");
  element.hidden = true;

  function emit() {
    render();
    deps.onChange?.(state);
  }

  function patch(next: Partial<AuthSnapshot>) {
    state = { ...state, ...next };
    emit();
  }

  function stopPolling() {
    if (pollHandle !== null) {
      clearTimer(pollHandle);
      pollHandle = null;
    }
  }

  function render() {
    element.replaceChildren();
    element.hidden = shouldHide();
    if (element.hidden) return;
    element.setAttribute("data-phase", state.phase);
    element.setAttribute("data-mode", state.mode);

    const text = el("p", "sfstore__auth-text");
    text.setAttribute("data-role", "auth-text");
    text.textContent = messageFor();
    element.append(text);

    const actions = el("div", "sfstore__auth-actions");
    for (const action of actionsFor()) {
      actions.append(action);
    }
    if (actions.childNodes.length) element.append(actions);
  }

  /** 旧商城、匿名模式、还没加载完：都不显示连接条（避免首屏闪一条用不上的提示）。 */
  function shouldHide(): boolean {
    if (state.mode === "unsupported" || state.mode === "anonymous") return true;
    if (state.phase === "loading") return true;
    return false;
  }

  function messageFor(): string {
    if (state.phase === "connected") {
      const who = state.account?.username || state.account?.displayName || "";
      // 到期时间按页面统一的本地时间格式显示，不把 ISO 串直接摆给操作者。
      const formatted = state.expiresAt ? formatDateTime(state.expiresAt) : "";
      const expiry = formatted ? copy.t("authExpiresAt", { time: formatted }) : "";
      return copy.t("authConnectedAs", { who, expiry });
    }
    if (state.phase === "waiting") {
      const base = copy.t("authWaiting", { code: state.code });
      // 静默重试等于「卡住了但不说」：把次数与最近一次原因写出来，操作者和我都能定位。
      return state.retries > 0
        ? `${base} ${copy.t("authRetrying", { count: state.retries, reason: state.lastFailure })}`
        : base;
    }
    if (state.phase === "connecting") return copy.t("authConnecting");
    if (state.phase === "error") return state.message || copy.t("authFailed");
    return copy.t("authRequired");
  }

  function actionsFor(): HTMLButtonElement[] {
    if (state.phase === "connected") {
      const button = buttonEl(copy.t("authDisconnectAction"));
      button.setAttribute("data-action", "auth-disconnect");
      button.addEventListener("click", () => void disconnect());
      return [button];
    }
    if (state.phase === "waiting" || state.phase === "connecting") {
      const button = buttonEl(copy.t("authCancelAction"));
      button.setAttribute("data-action", "auth-cancel");
      button.addEventListener("click", () => cancel());
      return [button];
    }
    const button = buttonEl(copy.t("authConnectAction"), "primary");
    button.setAttribute("data-action", "auth-connect");
    button.addEventListener("click", () => void connect());
    return [button];
  }

  function cancel() {
    stopPolling();
    requestId = "";
    patch({ phase: "idle", message: "", code: "" });
  }

  async function load(): Promise<void> {
    try {
      const payload = await deps.request<Record<string, unknown>>(AUTH_STATUS_PATH);
      if (disposed) return;
      const mode = readMode(payload?.mode);
      const connected = payload?.connected === true;
      patch({
        mode,
        connected,
        account: readAccount(payload?.account),
        expiresAt: readString(payload?.expiresAt) || null,
        phase: connected ? "connected" : "idle",
        message: "",
      });
    } catch (error) {
      if (disposed) return;
      // 读不到状态不该让页面变砖：按「不知道」处理，安装照旧走（商城会用 401 说话）。
      patch({
        phase: "error",
        mode: "anonymous",
        message: authMessageFor(error, copy),
      });
    }
  }

  async function connect(): Promise<void> {
    if (state.phase === "connecting" || state.phase === "waiting") return;
    // 先同步开窗：await 之后再 open 会被弹窗拦截。
    const tab = openWindow();
    patch({ phase: "connecting", message: "", code: "" });

    let start: Record<string, unknown>;
    try {
      start = await deps.request<Record<string, unknown>>(AUTH_START_PATH, {
        method: "POST",
        body: {},
      });
    } catch (error) {
      const message = authMessageFor(error, copy);
      // 先开窗后请求，请求失败时那个标签页还是 about:blank。把它写成一句人能读的话，
      // 而不是留一张白纸让操作者以为「点坏了」。
      explainInTab(tab, copy.t("authTabFailedTitle"), message);
      patch({ phase: "error", message });
      return;
    }
    if (disposed) {
      closeTab(tab);
      return;
    }

    requestId = readString(start?.requestId);
    const authorizeUrl = readString(start?.authorizeUrl);
    if (!requestId || !authorizeUrl) {
      explainInTab(tab, copy.t("authTabFailedTitle"), copy.t("authFailed"));
      patch({ phase: "error", message: copy.t("authFailed") });
      return;
    }

    const expiresIn = numberOr(start?.expiresIn, DEFAULT_EXPIRES_IN_SECONDS);
    pollIntervalSeconds = Math.max(
      MIN_INTERVAL_SECONDS,
      numberOr(start?.interval, DEFAULT_INTERVAL_SECONDS),
    );
    deadline = now() + Math.max(1, expiresIn) * 1000;

    if (tab) {
      try {
        tab.location.href = authorizeUrl;
      } catch {
        // 句柄不可导航（已关闭）：退化成让操作者自己打开。
      }
    } else {
      // 没有句柄说明弹窗被拦了：把地址写进连接条，操作者可以手动打开。
      patch({ phase: "error", message: copy.t("authPopupBlocked") });
      return;
    }

    patch({ phase: "waiting", code: shortCode(requestId) });
    schedulePoll();
  }

  function schedulePoll() {
    stopPolling();
    pollHandle = setTimer(
      () => {
        pollHandle = null;
        void poll();
      },
      Math.max(MIN_INTERVAL_SECONDS, pollIntervalSeconds) * 1000,
    );
  }

  async function poll(): Promise<void> {
    if (disposed || state.phase !== "waiting") return;
    if (now() > deadline) {
      stopPolling();
      patch({ phase: "error", message: copy.t("authExpired") });
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = await deps.request<Record<string, unknown>>(AUTH_POLL_PATH, {
        method: "POST",
        body: { requestId },
      });
    } catch (error) {
      if (disposed) return;
      // 传输抖动、宿主/插件重启、429 都不该把「等待授权」变成「连接失败」：
      // 商城的请求还在，继续轮询到截止时间才是对的。真正确定性的失败
      // （请求已失效、secret 写不进去）才终止。
      const { code, status } = failureOf(error);
      if (isTransientPollFailure(code, status) && now() <= deadline) {
        state = {
          ...state,
          retries: state.retries + 1,
          lastFailure: code || (status ? `HTTP ${status}` : "network"),
        };
        emit();
        schedulePoll();
        return;
      }
      stopPolling();
      patch({ phase: "error", message: authMessageFor(error, copy) });
      return;
    }
    if (disposed) return;

    const status = readString(payload?.status);
    if (status === "pending") {
      if (state.retries > 0) {
        state = { ...state, retries: 0, lastFailure: "" };
        emit();
      }
      schedulePoll();
      return;
    }
    stopPolling();
    requestId = "";
    if (status === "connected") {
      patch({
        phase: "connected",
        connected: true,
        account: readAccount(payload?.account),
        expiresAt: readString(payload?.expiresAt) || null,
        code: "",
        message: "",
      });
      return;
    }
    if (status === "denied") {
      patch({ phase: "error", message: copy.t("authDenied") });
      return;
    }
    if (status === "consumed") {
      patch({ phase: "error", message: copy.t("authConsumed") });
      return;
    }
    patch({ phase: "error", message: copy.t("authExpired") });
  }

  async function disconnect(): Promise<void> {
    try {
      await deps.request(AUTH_DISCONNECT_PATH, { method: "POST", body: {} });
      if (disposed) return;
      patch({ phase: "idle", connected: false, account: null, expiresAt: null, message: "", code: "" });
    } catch (error) {
      if (disposed) return;
      patch({ phase: "error", message: authMessageFor(error, copy) });
    }
  }

  function destroy() {
    disposed = true;
    stopPolling();
  }

  render();
  return {
    element,
    snapshot: () => state,
    isBlocking: () => state.mode === "account_required" && !state.connected,
    load,
    connect,
    disconnect,
    destroy,
  };
}

/**
 * 把一个还是 about:blank 的标签页写成失败说明。
 *
 * 为什么不直接 `close()`：脚本开出的窗口通常能关，但一旦宿主/浏览器拒绝，操作者手里就留下
 * 一张白纸，看不出是「连接失败」还是「页面坏了」。写一句话是两边都成立的结果；写不进去
 * （跨源、文档只读）才退化成关闭。
 */
function explainInTab(tab: AuthTab, title: string, message: string) {
  if (!tab) return;
  try {
    const doc = tab.document;
    if (doc && doc.body) {
      if (typeof doc.title === "string") doc.title = title;
      doc.body.textContent = `${title}\n\n${message}`;
      return;
    }
  } catch {
    // 跨源或被拒绝：往下走，尝试关闭。
  }
  closeTab(tab);
}

function closeTab(tab: AuthTab) {
  if (!tab || typeof tab.close !== "function") return;
  try {
    tab.close();
  } catch {
    // 关不掉就算了：about:blank 标签页对操作者没有危害。
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 短码只取前 8 位大写：和商城授权页上显示的是同一串。 */
export function shortCode(requestId: string): string {
  return requestId.replace(/-/g, "").slice(0, 8).toUpperCase();
}
