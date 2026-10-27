// 弹窗底部：版本 / 状态位 / 主按钮，四态同一行，高度恒 64px。
//
// 这里只负责「给定状态画节点」：状态在 catalog.ts，判定在 logic.ts 与 platform.ts。
// 抽出来的原因很实际：catalog.ts 已经贴着架构门禁的 1000 行上限，而这一块是自成一体的 UI。
//
// 平台不再出现在底部：架构由 `defaultPlatform` 按宿主 target 自动决定，安装条只负责说结论。

import { buttonEl, el, selectEl } from "./dom";
import { releaseSupportsTarget } from "./platform";
import type { Copy } from "./copy";
import type { InstallGate, PlatformDto, ReleaseView } from "./types";

/** 版本下拉里的一项：带关系结论，或（不支持当前架构时）带架构结论。 */
export function versionOptionLabel(
  release: ReleaseView,
  copy: Copy,
  target?: PlatformDto | null,
): string {
  const supported = target === undefined ? release.supported : releaseSupportsTarget(release, target);
  if (supported === false) {
    return copy.t("versionOptionUnsupported", {
      version: release.version,
      channel: release.channelLabel,
    });
  }
  return release.relationLabel
    ? copy.t("versionOptionWithRelation", {
        version: release.version,
        channel: release.channelLabel,
        relation: release.relationLabel,
      })
    : copy.t("versionOption", { version: release.version, channel: release.channelLabel });
}

export function versionOptions(
  releases: ReadonlyArray<ReleaseView>,
  copy: Copy,
  target?: PlatformDto | null,
): Array<{ value: string; label: string }> {
  return releases.map((release) => ({
    value: release.version,
    label: versionOptionLabel(release, copy, target),
  }));
}

export type FootInput = {
  /** 可安装版本（published 且有资产）。包含不支持当前架构的版本：它们要能被选中并说明原因。 */
  releases: ReadonlyArray<ReleaseView>;
  version: string;
  /** 宿主平台（插件后端所在服务器）；null = 老商城没回，页面不做架构判决。 */
  target: PlatformDto | null;
  gate: InstallGate;
  /** 门禁被触发时的原因文案，由 `installGateText` 生成。 */
  gateText: string;
  canInstall: boolean;
  /** 宿主提供 `installAndEnableExtension`：按钮与进行中文案必须说「启用」，不能只说安装。 */
  canEnable: boolean;
  pending: boolean;
  /** 本次安装回执的按钮文案（已启用 / 已升级 / 已暂存）；null = 还没有回执。 */
  receiptLabel: string | null;
  /** 状态位文案（安装中 / 已暂存 / 已签名 / 失败），空串 = 没有状态。 */
  stateText: string;
  tone: "" | "ok" | "bad";
  /** 商城要求登录而当前没有凭据：主按钮禁用并改文案，点击前就说清楚。 */
  authBlocked?: boolean;
  /** 正在等商城授权：按钮保持禁用，避免重复开窗。 */
  authWaiting?: boolean;
};

/**
 * 底部节点序列。`noInstallableVersion` 是唯一提前返回：一个可装版本都没有时，
 * 版本下拉也没有意义。
 */
export function footNodes(input: FootInput, copy: Copy): HTMLElement[] {
  if (!input.releases.length) {
    return [el("p", "sfstore__notice", copy.t("noInstallableVersion"))];
  }

  const versionSelect = selectEl(versionOptions(input.releases, copy, input.target), input.version);
  versionSelect.setAttribute("data-action", "version");
  versionSelect.setAttribute("aria-label", copy.t("versionSelectAria"));
  versionSelect.classList.add("sfstore__foot-select");
  // 平台下拉已经不在了：版本下拉独占一行，窄屏两列网格不会在旁边留半格空洞。
  versionSelect.classList.add("sfstore__foot-select--wide");

  const nodes: HTMLElement[] = [versionSelect];

  const stateEl = el("p", "sfstore__foot-state");
  stateEl.setAttribute("data-role", "foot-state");
  const actionArea = el("div", "sfstore__foot-actions");
  const done = input.receiptLabel !== null;
  let stateText = input.stateText;

  if (input.canInstall && input.gate.installable && input.authWaiting) {
    // 等待授权：按钮禁用并改文案。这一支必须排在 authBlocked 之前 —— 等待期间
    // 「未连接」仍然成立，先判 blocked 会让按钮一直显示「登录后安装」且可点。
    const waiting = buttonEl(copy.t("waitingAuthAction"), "primary");
    waiting.setAttribute("data-action", "auth-waiting");
    waiting.disabled = true;
    waiting.classList.add("sfstore__foot-action", "sfstore__btn--auth");
    actionArea.append(waiting);
    stateText = copy.t("authWaitingHint");
  } else if (input.canInstall && input.gate.installable && input.authBlocked) {
    // 登录闸门排在安装门禁前面：门禁说的是「这一版能不能装」，闸门说的是「现在能不能签发」。
    // 两者都挡住时先说签发 —— 连接之后门禁的结论才可执行。
    //
    // 这枚按钮是**可点的**：弹窗盖住了目录顶部的连接条，这里不给入口就等于没有入口。
    // 文案仍是「登录后安装」（说的是结果），点击动作是发起连接（说的是这一步做什么）。
    const connect = buttonEl(copy.t("loginRequiredAction"), "primary");
    connect.setAttribute("data-action", "auth-connect");
    connect.classList.add("sfstore__foot-action", "sfstore__btn--auth");
    actionArea.append(connect);
    // 登录闸门比「支持当前架构」更该被看见：后者说的是这一版能不能装，
    // 前者说的是「你现在点不动任何东西，先去做这件事」。
    stateText = copy.t("loginRequiredHint");
  } else if (input.canInstall && input.gate.installable) {
    const actionButton = buttonEl(
      input.authWaiting
        ? copy.t("waitingAuthAction")
        : input.pending
          ? copy.t(input.canEnable ? "installAndEnablePendingAction" : "installPendingAction")
          : done
            ? (input.receiptLabel as string)
            : input.gate.upgrade
              ? copy.t(
                  input.canEnable ? "installUpdateAndEnableAction" : "installUpdateAction",
                  { version: input.version },
                )
              : copy.t(input.canEnable ? "installAndEnableAction" : "installAction"),
      "primary",
    );
    actionButton.setAttribute("data-action", "install");
    actionButton.disabled = input.pending || done || input.authWaiting === true;
    actionButton.classList.add("sfstore__foot-action");
    actionArea.append(actionButton);
  } else if (input.canInstall) {
    // 被门禁挡住时不留空位：同一槽位保留一枚禁用主按钮，原因写在状态位。
    // 只有「已装什么」这一种原因能用 `已安装 vX` 当按钮名；架构不支持说的是「这一版装不上」，
    // 按钮保持中性文案并禁用，否则会读成「你已经装了」。
    const blocked = input.gate.installable ? null : input.gate;
    const blockedButton = buttonEl(
      blocked?.reason === "platformUnsupported"
        ? copy.t("installAction")
        : copy.t("installedAction", { version: blocked?.installedVersion ?? "" }),
      "primary",
    );
    blockedButton.setAttribute("data-action", "install-blocked");
    blockedButton.disabled = true;
    blockedButton.classList.add("sfstore__foot-action");
    actionArea.append(blockedButton);
    if (stateText === "" && blocked) stateText = input.gateText;
  } else {
    // 老宿主只有「获取签名链接」这一条路，但签名是**商城自己的动作**：明知这一版在当前机器上
    // 跑不起来还签发下载链接，等于把坏包递出去。架构不支持时同样禁用，原因写在状态位。
    // 其余门禁原因（同版本 / 降级）不拦签名 —— 那条路径本来就是让操作者绕过页面门禁去 core 处理。
    const platformBlocked = !input.gate.installable && input.gate.reason === "platformUnsupported";
    // 旧宿主只能拿签名链接，但签名同样要过登录闸门：没有令牌，商城会 401。
    const authBlocked = input.authBlocked === true;
    const actionButton = buttonEl(
      authBlocked
        ? copy.t("loginRequiredAction")
        : input.authWaiting
          ? copy.t("waitingAuthAction")
          : platformBlocked
            ? copy.t("signAction")
            : input.pending
              ? copy.t("signPendingAction")
              : copy.t("signAction"),
      "primary",
    );
    // 旧宿主的签名路径同样要能从这里发起连接：弹窗盖住连接条时，这是唯一的入口。
    actionButton.setAttribute(
      "data-action",
      authBlocked ? "auth-connect" : platformBlocked ? "sign-blocked" : "sign",
    );
    actionButton.disabled = platformBlocked || input.pending || done || input.authWaiting === true;
    actionButton.classList.add("sfstore__foot-action");
    if (authBlocked) actionButton.classList.add("sfstore__btn--auth");
    actionArea.append(actionButton);
    if (authBlocked) stateText = copy.t("loginRequiredHint");
    else if (platformBlocked && stateText === "") stateText = input.gateText;
  }

  stateEl.textContent = stateText;
  if (stateText) stateEl.title = stateText;
  if (input.tone) stateEl.classList.add(`sfstore__foot-state--${input.tone}`);
  nodes.push(stateEl, actionArea);
  return nodes;
}
