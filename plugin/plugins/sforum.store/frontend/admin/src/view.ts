// Presentational builders for the store page: given view models, return elements.
// No request, timer, or event wiring lives here — `catalog.ts` owns state, `dialog.ts`
// owns the dialog mechanics (focus, tabs, Esc).
// Every user-visible string comes from the `Copy` table, so both locales render
// through the same code path.

import { badge, buttonEl, el, mono } from "./dom";
import type { BadgeTone } from "./dom";
import { formatDateTime, initialOf } from "./logic";
import type { Copy } from "./copy";
import type {
  AuthorView,
  CatalogItemView,
  HostInstallEnableOutcome,
  HostInstallResult,
  InstalledView,
  InstallUrlResponseDto,
  ProductView,
  ReleaseView,
} from "./types";

/** 弹窗标题的锚点：`aria-labelledby` 指向这个 id。 */
export const DIALOG_TITLE_ID = "sfstore-dialog-title";

/** 卡片固定 5 个徽标槽位：≤5 全显，>5 显示前 4 枚 + `+N`。 */
const CARD_BADGE_SLOTS = 5;
/** 卡片只给前两个平台打标；完整列表在弹窗里。 */
const CARD_PLATFORM_LIMIT = 2;
/** 首屏骨架卡数量：够铺满一行，又不至于在窄屏堆成一片灰。 */
const SKELETON_COUNT = 4;

/**
 * Success copy shared by the toast and the staged receipt. A staged package is not
 * enabled yet: enabling and trusting happen in core, never here.
 */
export function trustNote(copy: Copy): string {
  return copy.t("trustNote");
}

export function stateBlock(
  copy: Copy,
  options: { title?: string; text: string; action?: { label: string; name: string } },
): HTMLElement {
  const wrap = el("div", "sfstore__state");
  if (options.title) wrap.append(el("p", "sfstore__state-title", options.title));
  wrap.append(el("p", "sfstore__state-text", options.text));
  if (options.action) {
    const actionButton = buttonEl(options.action.label);
    actionButton.setAttribute("data-action", options.action.name);
    wrap.append(actionButton);
  }
  return wrap;
}

/**
 * 封面 / 图标：同一个盒子，三级回退。
 *
 * 1. `socialImageUrl` —— 商城托管的品牌分享卡（1280×640），CSS 按 2:1 裁切；
 * 2. `iconUrl` —— 商城托管的方形图标；
 * 3. 字母块（`initial`）—— 在有图片之前页面用的那一级。
 *
 * 两个尺寸共用一套回退：`card`（卡片封面 2:1，图 320×160）与 `dialog`（弹窗 mark 96×48）。
 *
 * `<img>` 手写而不是走 `bridge.icons`：这个页面没有 Host 图标运行时，分享卡也不是图标字体
 * 的字形。每一级 `onerror` 只退到下一级，所以商城不可达、资产被清理、宿主 `img-src` 被拦，
 * 最终都落成一块字母砖，而不是一张破图。
 */
type MarkVariant = "card" | "dialog";

type MarkInput = {
  socialImageUrl: string | null;
  iconUrl: string | null;
  initial: string;
  variant?: MarkVariant;
};

function markImage(className: string, width: number, height: number): HTMLImageElement {
  const img = el("img", className) as HTMLImageElement;
  img.alt = "";
  img.width = width;
  img.height = height;
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  return img;
}

function markEl(input: MarkInput): HTMLElement {
  const variant = input.variant ?? "card";
  const box = el("span", variant === "card" ? "sfstore__card-cover" : "sfstore__dialog-mark");
  box.setAttribute("aria-hidden", "true");

  // 最后一级：字母块。任何破图都落到这里，而不是留在页面上。
  const showInitial = () => {
    box.replaceChildren();
    if (variant === "card") {
      box.append(el("span", "sfstore__card-mark", input.initial));
    } else {
      box.textContent = input.initial;
    }
  };

  const showIcon = () => {
    if (!input.iconUrl) {
      showInitial();
      return;
    }
    const img = markImage("sfstore__mark-img", 40, 40);
    img.addEventListener("error", showInitial, { once: true });
    img.src = input.iconUrl;
    box.replaceChildren();
    if (variant === "card") {
      const mark = el("span", "sfstore__card-mark");
      mark.append(img);
      box.append(mark);
    } else {
      box.append(img);
    }
  };

  if (!input.socialImageUrl) {
    showIcon();
    return box;
  }

  const width = variant === "card" ? 320 : 192;
  const img = markImage("sfstore__cover-img", width, width / 2);
  // 先挂回退，再赋 src：某些实现赋值即开始加载。
  img.addEventListener("error", showIcon, { once: true });
  img.src = input.socialImageUrl;
  box.replaceChildren(img);
  return box;
}

type CardBadge = { label: string; tone: BadgeTone; title?: string };

/**
 * 卡片徽标顺序：类型 → 版本 → 架构判决 → 已安装 → 平台（最多 2） → 约束 → 兼容判决。
 * 前 4 枚因此正好是决策信息；被折掉的结论在 `+N` 的 `title` 里仍可读到。
 *
 * 架构判决紧跟版本号：一个在这台服务器上跑不起来的包，先说这个，再说已装了什么。
 * `supported === null`（没有 target / 没有平台信息）不画 —— 未知不是「不支持」。
 *
 * 「支持当前架构」是正向结论，它顶掉原始平台 chip（清单进 `title`）：两者说的是同一件事，
 * 一起放会让每张支持本机的卡都多一枚徽标、多一次折行。不支持的卡保留 chip ——
 * 那时 chip 是解释（这包其实是给 darwin 的），不是重复。
 */
function cardBadges(item: CatalogItemView, copy: Copy): CardBadge[] {
  const entries: CardBadge[] = [{ label: item.kindLabel, tone: "neutral" }];
  if (item.latestVersion) entries.push({ label: `v${item.latestVersion}`, tone: "neutral" });
  const platformList = item.platformLabels.join(" · ");
  if (item.supported === true) {
    entries.push({ label: copy.t("platformSupportedBadge"), tone: "ok", title: platformList });
  } else if (item.supported === false) {
    entries.push(
      item.supportedAnywhere === true
        ? {
            label: copy.t("platformLatestUnsupportedBadge"),
            tone: "warn",
            title: copy.t("platformUnsupportedCardTitle", { version: item.latestVersion }),
          }
        : { label: copy.t("platformUnsupportedBadge"), tone: "warn", title: platformList },
    );
  }
  if (item.installed) entries.push({ label: item.installed.versionLabel, tone: "ok" });
  if (item.supported !== true) {
    for (const platform of item.platformLabels.slice(0, CARD_PLATFORM_LIMIT)) {
      entries.push({ label: platform, tone: "muted" });
    }
  }
  if (item.constraint) {
    entries.push({ label: `sforum ${item.constraint.text}`, tone: "muted", title: item.constraint.title });
  }
  // 架构判决为「任何版本都跑不了」时不再画兼容徽标：同一原因（架构）不说两遍。
  // 「最新版不行、旧版可以」例外 —— 那时的兼容结论说的是版本轴，是另一件事。
  const duplicateOfPlatform = item.supported === false && item.supportedAnywhere === false;
  // Only a real verdict gets a badge; a page without a host version says so once above.
  if (item.compatibility && !duplicateOfPlatform) {
    entries.push({ label: item.compatibility.label, tone: item.compatibility.tone });
  }
  return entries;
}

/**
 * 目录卡片。整张卡是一个按钮：封面、名称、摘要、徽标都在按钮里，点击即开弹窗。
 * 封面右上角只放一枚状态角标（可更新优先于已安装），「已安装」本身仍留在徽标里。
 */
export function catalogCardView(item: CatalogItemView, copy: Copy): HTMLElement {
  const card = el("button", "sfstore__card") as HTMLButtonElement;
  card.type = "button";
  card.setAttribute("data-slug", item.slug);
  card.setAttribute("aria-haspopup", "dialog");
  card.setAttribute("aria-label", copy.t("cardAria", { name: item.name }));

  const cover = markEl({
    socialImageUrl: item.socialImageUrl,
    iconUrl: item.iconUrl,
    initial: item.initial,
    variant: "card",
  });
  const flag = item.installed
    ? item.installed.updateLabel
      ? { label: item.installed.updateLabel, tone: "update" as const }
      : { label: item.installed.versionLabel, tone: "installed" as const }
    : null;
  if (flag) {
    const corner = el("span", `sfstore__card-flag sfstore__card-flag--${flag.tone}`, flag.label);
    corner.title = flag.label;
    cover.append(corner);
  }
  card.append(cover);

  const body = el("span", "sfstore__card-body");
  body.append(el("span", "sfstore__card-name", item.name));
  const idLine = el("span", "sfstore__card-id");
  idLine.title = item.extensionId;
  idLine.append(mono(item.extensionId));
  body.append(idLine);
  // 摘要始终占位（哪怕是空的），同一行的卡片才能对齐。
  body.append(el("span", "sfstore__card-summary", item.summary));

  const badges = cardBadges(item, copy);
  const meta = el("span", "sfstore__card-meta");
  const shown = badges.length > CARD_BADGE_SLOTS ? badges.slice(0, CARD_BADGE_SLOTS - 1) : badges;
  for (const entry of shown) meta.append(badge(entry.label, entry.tone, entry.title));
  if (badges.length > CARD_BADGE_SLOTS) {
    meta.append(
      badge(
        copy.t("cardMetaOverflow", { count: badges.length - (CARD_BADGE_SLOTS - 1) }),
        "muted",
        badges.map((entry) => entry.label).join(" · "),
      ),
    );
  }
  body.append(meta);
  card.append(body);
  return card;
}

/** 首屏占位卡：与真卡同几何，静态灰块 + 轻微呼吸（尊重 reduced-motion）。 */
export function catalogSkeletonCards(count = SKELETON_COUNT): HTMLElement[] {
  const cards: HTMLElement[] = [];
  for (let index = 0; index < count; index += 1) {
    const card = el("div", "sfstore__card sfstore__card--skeleton");
    card.setAttribute("aria-hidden", "true");
    card.append(el("span", "sfstore__card-cover"));
    const body = el("span", "sfstore__card-body");
    body.append(
      el("span", "sfstore__skeleton sfstore__skeleton--title"),
      el("span", "sfstore__skeleton sfstore__skeleton--id"),
      el("span", "sfstore__skeleton sfstore__skeleton--line"),
      el("span", "sfstore__skeleton sfstore__skeleton--line2"),
      el("span", "sfstore__skeleton sfstore__skeleton--meta"),
    );
    card.append(body);
    cards.push(card);
  }
  return cards;
}

type DialogHeaderInput = {
  name: string;
  extensionId: string;
  kindLabel: string;
  latestVersion: string;
  socialImageUrl: string | null;
  iconUrl: string | null;
  initial: string;
  installed: InstalledView | null;
  statusNote: string | null;
};

/**
 * 弹窗头部：96×48 mark + 标题（`aria-labelledby` 的锚点）+ 副行（扩展 ID + ≤2 枚徽标）。
 * 摘要与平台留在卡片上，头部只放身份与状态，高度稳定在 84–106px。
 */
export function dialogHeader(input: DialogHeaderInput, copy: Copy): HTMLElement {
  const wrap = el("div", "sfstore__dialog-head");
  wrap.append(
    markEl({
      socialImageUrl: input.socialImageUrl,
      iconUrl: input.iconUrl,
      initial: input.initial,
      variant: "dialog",
    }),
  );

  const main = el("div", "sfstore__dialog-main");
  const name = el("h2", "sfstore__dialog-name", input.name);
  name.id = DIALOG_TITLE_ID;
  main.append(name);

  const sub = el("p", "sfstore__dialog-sub");
  sub.append(mono(input.extensionId));
  sub.append(badge(input.kindLabel));
  // 弹窗里没有封面角标：已装版本与可更新必须同时可见（现在装的是什么、能升到什么）。
  if (input.installed) {
    sub.append(badge(input.installed.versionLabel, "ok"));
    if (input.installed.updateLabel) sub.append(badge(input.installed.updateLabel, "accent"));
  } else if (input.latestVersion) {
    sub.append(badge(`v${input.latestVersion}`));
  }
  if (input.statusNote) sub.append(el("span", "sfstore__hint", input.statusNote));
  main.append(sub);

  wrap.append(main);
  return wrap;
}

/** 卡片数据先到、产品详情还在路上时的头部：同一个构建器，字段一一对应。 */
export function dialogHeaderFromItem(item: CatalogItemView, copy: Copy): HTMLElement {
  return dialogHeader(
    {
      name: item.name,
      extensionId: item.extensionId,
      kindLabel: item.kindLabel,
      latestVersion: item.latestVersion,
      socialImageUrl: item.socialImageUrl,
      iconUrl: item.iconUrl,
      initial: item.initial,
      installed: item.installed,
      statusNote: item.installed?.statusNote ?? null,
    },
    copy,
  );
}

export function dialogHeaderFromView(view: ProductView, copy: Copy): HTMLElement {
  return dialogHeader(
    {
      name: view.name,
      extensionId: view.extensionId,
      kindLabel: view.kindLabel,
      latestVersion: view.latestVersion,
      socialImageUrl: view.socialImageUrl,
      iconUrl: view.iconUrl,
      initial: initialOf(view.name),
      installed: view.installed,
      statusNote: view.installed?.statusNote ?? null,
    },
    copy,
  );
}

export function signedBlock(signed: InstallUrlResponseDto, copy: Copy): HTMLElement {
  const wrap = el("div", "sfstore__signed");

  const linkInput = el("input", "sfstore__input sfstore__input--mono") as HTMLInputElement;
  linkInput.type = "text";
  linkInput.readOnly = true;
  linkInput.value = signed.url;
  linkInput.setAttribute("data-role", "signed-url");
  linkInput.setAttribute("aria-label", copy.t("signedUrlLabel"));
  const field = el("label", "sfstore__field");
  field.append(el("span", "sfstore__label", copy.t("signedUrlLabel")), linkInput);
  wrap.append(field);

  const copyButton = buttonEl(copy.t("copyLinkAction"));
  copyButton.setAttribute("data-action", "copy");
  const coreButton = buttonEl(copy.t("openCoreInstallAction"));
  coreButton.setAttribute("data-action", "open-core-install");
  const actions = el("div", "sfstore__actions");
  actions.append(copyButton, coreButton);
  wrap.append(actions);

  const expires = signed.expiresAt ? copy.t("signedExpires", { time: formatDateTime(signed.expiresAt) }) : "";
  wrap.append(el("p", "sfstore__hint", copy.t("signedHint", { expires })));
  const digestLine = el("p", "sfstore__hint");
  digestLine.append(document.createTextNode(copy.t("sha256Label")), mono(signed.sha256, signed.sha256));
  wrap.append(digestLine);

  return wrap;
}

/** 已暂存回执：只说结论与下一步，摘要明细在「版本信息」分区里。 */
/**
 * 安装回执。措辞只转述宿主做完的事：
 * - `enabled` / `upgraded` 来自宿主 `installAndEnableExtension` 的 `outcome`，写成「宿主已…」；
 * - `staged` 或缺省（旧宿主没有 outcome）仍然只是暂存，启用与信任留给 core。
 * 两种回执都给完整制品摘要：管理员要拿它对上商城签名里的 sha256。
 */
export function receiptBlock(
  result: HostInstallResult,
  copy: Copy,
  outcome: HostInstallEnableOutcome | null = null,
): HTMLElement {
  const running = outcome === "enabled" || outcome === "upgraded";
  const wrap = el("div", "sfstore__receipt");
  wrap.setAttribute("data-outcome", outcome ?? "staged");
  wrap.append(
    el(
      "p",
      "sfstore__status-title",
      copy.t(running ? (outcome === "enabled" ? "enabledTitle" : "upgradedTitle") : "stagedTitle"),
    ),
  );
  // 主题没有「启用与信任」这一步：它要去主题页激活，文案不能照抄插件。
  const theme = result.type === "theme";
  const noteKey = running
    ? outcome === "enabled"
      ? "enabledNote"
      : "upgradedNote"
    : theme
      ? "stagedThemeNote"
      : "trustNote";
  wrap.append(el("p", "sfstore__note", copy.t(noteKey)));
  // 已经在跑就别再让人去 core 完成升级/信任：那两句只对「只暂存」成立。
  if (!running) {
    if (result.upgraded) wrap.append(el("p", "sfstore__hint", copy.t("stagedUpgradedHint")));
    if (result.requiresTrust) wrap.append(el("p", "sfstore__hint", copy.t("stagedTrustHint")));
  }

  const digestLine = el("p", "sfstore__hint");
  digestLine.append(document.createTextNode(copy.t("labelPackageDigest")), mono(result.packageDigest));
  wrap.append(digestLine);

  const coreButton = buttonEl(copy.t(theme ? "openCoreThemeAction" : "openCoreAction"), "primary");
  coreButton.setAttribute("data-action", "open-core");
  wrap.append(coreButton);
  return wrap;
}

/**
 * 启用阶段的失败回执：包已经装好，只是没跑起来。没有 result 可用（promise 是 reject
 * 回来的），所以只给状态 + 原因 + 去 core 的入口，不提供重装。
 */
export function partialBlock(message: string, copy: Copy): HTMLElement {
  const wrap = el("div", "sfstore__receipt");
  wrap.setAttribute("data-outcome", "pending-enable");
  wrap.append(el("p", "sfstore__status-title", copy.t("partialTitle")));
  wrap.append(el("p", "sfstore__note", copy.t("partialNote")));
  if (message) wrap.append(el("p", "sfstore__hint", message));
  const coreButton = buttonEl(copy.t("openCoreAction"), "primary");
  coreButton.setAttribute("data-action", "open-core");
  wrap.append(coreButton);
  return wrap;
}

/**
 * Maintainer strip: avatar + name + forum handle + GitHub repository account.
 *
 * It renders above the README (the default tab) so the first thing an admin sees in the
 * dialog is who published the package. Two independent halves come from the store, and a
 * missing half is simply absent — no placeholder, no borrowed name.
 *
 * The avatar is an `<img>` with a letter fallback: the forum or the store may be unreachable
 * and the panel must never show a broken picture. Links are plain text-styled anchors because
 * a hand-written ESM page has no Host icon runtime.
 */
export function authorStrip(view: AuthorView, copy: Copy): HTMLElement {
  const wrap = el("div", "sfstore__author");
  wrap.setAttribute("aria-label", copy.t("authorAria"));

  const avatar = el("span", "sfstore__author-avatar");
  avatar.setAttribute("aria-hidden", "true");
  if (view.avatarUrl) {
    const img = markImage("sfstore__author-img", 32, 32);
    img.addEventListener(
      "error",
      () => {
        avatar.replaceChildren(el("span", "sfstore__author-initial", view.initial));
      },
      { once: true },
    );
    img.src = view.avatarUrl;
    avatar.append(img);
  } else {
    avatar.append(el("span", "sfstore__author-initial", view.initial));
  }

  const body = el("div", "sfstore__author-body");
  const name = el("p", "sfstore__author-name", view.name);
  // 昵称后面的 @登录名指回论坛个人主页。地址由商城按 issuer 基址拼好（页面拿不到论坛域名），
  // 缺失时退成纯文本 —— 一个点不动的 @ 好过一个 404 的链接。
  if (view.handle) {
    if (view.profileUrl) {
      const link = el("a", "sfstore__author-handle sfstore__author-profile", ` ${view.handle}`) as HTMLAnchorElement;
      link.href = view.profileUrl;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      link.title = copy.t("authorProfileTitle");
      name.append(link);
    } else {
      name.append(el("span", "sfstore__author-handle", ` ${view.handle}`));
    }
  }
  body.append(name);

  // 副行只讲 GitHub 那一半，并且带上它自己的标签：第一行是论坛账号（名字 + @用户名），
  // 这里写「GitHub 仓库账号 @org」。没有 GitHub 就不画这一行 —— 论坛账号已经在第一行，
  // 再写一次「论坛账号」只是在占位置。
  if (view.github) {
    const meta = el("p", "sfstore__author-meta");
    meta.append(el("span", "sfstore__author-label", copy.t("authorGithubAccount")));
    const link = el("a", "sfstore__link", `@${view.github.login}`) as HTMLAnchorElement;
    link.href = view.github.url;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.title = view.github.url;
    meta.append(link);
    body.append(meta);
  }

  wrap.append(avatar, body);
  return wrap;
}

/**
 * README block. The store renders the repository README and sanitises it against a
 * whitelist (no script, style, on* handlers or iframe; https-only images; external links
 * nofollow) before it ever reaches the page, and that HTML is the only representation the
 * page gets — there is no markdown source and no client-side rendering.
 *
 * `innerHTML` is therefore deliberate: the markup is already sanitised upstream, so the
 * page injects it as-is. Do not feed anything but `readme.html` into this container, and
 * do not add a second, weaker sanitizer that would silently rewrite the content.
 */
export function readmeBlock(view: ProductView, copy: Copy): HTMLElement {
  const block = el("div", "sfstore__block");
  const readme = view.readme;
  if (!readme) {
    block.append(el("p", "sfstore__prose", copy.t("readmeEmpty")));
    return block;
  }

  if (readme.sourceUrl) {
    const link = el("a", "sfstore__link", copy.t("readmeSource")) as HTMLAnchorElement;
    link.href = readme.sourceUrl;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    block.append(link);
  }

  // Container class is part of the styling contract (`sforum-store-readme` in catalog.css).
  const body = el("div", "sforum-store-readme");
  body.innerHTML = readme.html;
  block.append(body);
  return block;
}

export function versionsBlock(view: ProductView, copy: Copy): HTMLElement {
  const wrap = el("div", "sfstore__table-wrap");
  const table = el("table", "sfstore__table");
  const caption = el("caption", "sfstore__sr-only", copy.t("versionsCaption"));
  table.append(caption);

  // Same labels feed the responsive `content: attr(data-label)` cells in CSS.
  const columns = [
    copy.t("labelVersion"),
    copy.t("labelChannel"),
    copy.t("labelDate"),
    copy.t("labelConstraint"),
    copy.t("labelCapabilities"),
    copy.t("labelDigest"),
  ];
  const headRow = el("tr");
  for (const label of columns) {
    const cell = el("th", undefined, label);
    cell.setAttribute("scope", "col");
    headRow.append(cell);
  }
  const thead = el("thead");
  thead.append(headRow);
  table.append(thead);

  const body = el("tbody");
  for (const release of view.releases) {
    body.append(versionRow(release, copy));
  }
  table.append(body);
  wrap.append(table);
  return wrap;
}

export function versionRow(release: ReleaseView, copy: Copy): HTMLElement {
  const row = el("tr");
  const labels = {
    version: copy.t("labelVersion"),
    channel: copy.t("labelChannel"),
    date: copy.t("labelDate"),
    constraint: copy.t("labelConstraint"),
    capabilities: copy.t("labelCapabilities"),
    digest: copy.t("labelDigest"),
  };

  const versionCell = el("td");
  versionCell.setAttribute("data-label", labels.version);
  versionCell.append(mono(release.version));
  if (release.status !== "published") versionCell.append(badge(release.statusLabel, "warn"));
  row.append(versionCell);

  row.append(cell(labels.channel, release.channelLabel));
  row.append(cell(labels.date, release.publishedLabel || "—"));
  row.append(cell(labels.constraint, release.sforumVersion || "—"));
  row.append(cell(labels.capabilities, release.capabilities.length ? release.capabilities.join(" · ") : "—"));

  const digestCell = el("td");
  digestCell.setAttribute("data-label", labels.digest);
  if (release.digestPrefix) {
    digestCell.append(mono(release.digestPrefix, release.digest || undefined));
  } else {
    digestCell.textContent = "—";
  }
  row.append(digestCell);
  return row;
}

export function cell(label: string, value: string): HTMLElement {
  const node = el("td", undefined, value);
  node.setAttribute("data-label", label);
  return node;
}

function publishedTime(value: string): number {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/**
 * 更新说明：所有带正文的 release，按 `publishedAt` 倒序。
 *
 * 两种正文，同一条信任链：
 *
 * 1. `notesHtml` —— 商城把 GitHub Release 原文渲染过 markdown-it，并过与 README 同一份
 *    sanitize-html 白名单：禁 script、style、on* 事件属性与 iframe，图片 https-only，
 *    外链 nofollow。
 *    页面直接 `innerHTML` 注入，容器复用 `.sforum-store-readme`，不引入第二套消毒器 ——
 *    第二套只会悄悄改写内容，而真正的保证来自服务端。
 * 2. `notes` —— 老商城不发送渲染结果，退回 `white-space: pre-wrap` 的纯文本：`##` 会原样
 *    出现，但不会空白，也不会假装渲染过。
 *
 * 头部是 `h3`：弹窗标题是 `h2`，商城把正文标题压到 `h4` 以下（见 `render.ts` 的
 * `notesHeadingTag`），大纲因此单调，不出现「正文 h2 比标题还高」。
 */
export function notesBlock(view: ProductView, copy: Copy): HTMLElement {
  const wrap = el("div", "sfstore__notes");
  const entries = view.releases
    .filter((release) => release.notes.trim() !== "" || release.notesHtml !== "")
    .slice()
    .sort((left, right) => publishedTime(right.publishedAt) - publishedTime(left.publishedAt));

  if (!entries.length) {
    wrap.append(el("p", "sfstore__prose", copy.t("notesEmpty")));
    return wrap;
  }

  for (const release of entries) {
    const item = el("section", "sfstore__note-item");
    const head = [release.version ? `v${release.version}` : "", release.channelLabel, release.publishedLabel]
      .filter(Boolean)
      .join(" · ");
    item.append(el("h3", "sfstore__note-head", head));
    if (release.notesHtml !== "") {
      const body = el("div", "sforum-store-readme");
      body.innerHTML = release.notesHtml;
      item.append(body);
    } else {
      item.append(el("p", "sfstore__prose", release.notes.trim()));
    }
    wrap.append(item);
  }
  return wrap;
}
