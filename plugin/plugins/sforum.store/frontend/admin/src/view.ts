// Presentational builders for the store page: given view models, return elements.
// No request, timer, or event wiring lives here — `catalog.ts` owns state.
// Every user-visible string comes from the `Copy` table, so both locales render
// through the same code path.

import { badge, buttonEl, el, fieldEl, mono } from "./dom";
import { findRelease, formatDateTime, initialOf } from "./logic";
import type { Copy } from "./copy";
import type {
  CatalogItemView,
  HostInstallResult,
  InstallUrlResponseDto,
  ProductView,
  ReleaseView,
} from "./types";

/**
 * Success copy shared by the toast and the staged block. A staged package is not
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
 * 封面 / 图标：同一个元素，三级回退。
 *
 * 1. `socialImageUrl` —— 商城托管的品牌分享卡（1280×640），CSS 按 2:1 裁切；
 * 2. `iconUrl` —— 商城托管的方形图标；
 * 3. 字母块（`initial`）—— 在有图片之前页面用的那一级。
 *
 * `<img>` 手写而不是走 `bridge.icons`：这个页面没有 Host 图标运行时，分享卡也不是图标字体
 * 的字形。每一级 `onerror` 只退到下一级，所以商城不可达、资产被清理、宿主 `img-src` 被拦，
 * 最终都落成一块字母砖，而不是一张破图。
 */
type MarkInput = {
  socialImageUrl: string | null;
  iconUrl: string | null;
  initial: string;
  large?: boolean;
};

function tileClass(large?: boolean): string {
  return large ? "sfstore__tile sfstore__tile--lg" : "sfstore__tile";
}

function markImage(
  className: string,
  width: number,
  height: number,
): HTMLImageElement {
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
  const tile = el("span", tileClass(input.large));
  tile.setAttribute("aria-hidden", "true");

  // 最后一级：字母块。任何破图都落到这里，而不是留在页面上。
  const showInitial = () => {
    tile.className = tileClass(input.large);
    tile.replaceChildren();
    tile.textContent = input.initial;
  };

  const showIcon = () => {
    if (!input.iconUrl) {
      showInitial();
      return;
    }
    const side = input.large ? 40 : 32;
    const img = markImage("sfstore__tile-img", side, side);
    img.addEventListener("error", showInitial, { once: true });
    img.src = input.iconUrl;
    tile.className = tileClass(input.large);
    tile.replaceChildren(img);
  };

  if (!input.socialImageUrl) {
    showIcon();
    return tile;
  }

  const width = input.large ? 128 : 96;
  const img = markImage("sfstore__cover-img", width, width / 2);
  // 先挂回退，再赋 src：某些实现赋值即开始加载。
  img.addEventListener("error", showIcon, { once: true });
  img.src = input.socialImageUrl;
  tile.className = `${tileClass(input.large)} sfstore__tile--cover`;
  tile.replaceChildren(img);
  return tile;
}

export function catalogRowView(item: CatalogItemView, active: boolean): HTMLElement {
  const row = el("button", "sfstore__row") as HTMLButtonElement;
  row.type = "button";
  row.setAttribute("data-slug", item.slug);

  row.setAttribute("aria-pressed", active ? "true" : "false");
  if (active) row.classList.add("sfstore__row--active");

  const tile = markEl({
    socialImageUrl: item.socialImageUrl,
    iconUrl: item.iconUrl,
    initial: item.initial,
  });

  const main = el("span", "sfstore__row-main");
  main.append(el("span", "sfstore__row-title", item.name));
  const idLine = el("span", "sfstore__row-id");
  idLine.append(mono(item.extensionId));
  main.append(idLine);
  if (item.summary) main.append(el("span", "sfstore__row-summary", item.summary));

  const meta = el("span", "sfstore__row-meta");
  meta.append(badge(item.kindLabel));
  if (item.latestVersion) meta.append(badge(`v${item.latestVersion}`));
  // 宿主清单里的已装版本与可更新提示：卡片只给结论，宿主状态留到详情说。
  if (item.installed) {
    meta.append(badge(item.installed.versionLabel, "ok"));
    if (item.installed.updateLabel) meta.append(badge(item.installed.updateLabel, "accent"));
  }
  for (const platform of item.platformLabels.slice(0, 2)) meta.append(badge(platform, "muted"));
  // What the package asks of a host — the same string core evaluates at install time.
  if (item.constraint) {
    const chip = badge(`sforum ${item.constraint.text}`, "muted");
    chip.title = item.constraint.title;
    meta.append(chip);
  }
  // Only a real verdict gets a badge; a page without a host version says so once above.
  if (item.compatibility) meta.append(badge(item.compatibility.label, item.compatibility.tone));

  row.append(tile, main, meta);
  return row;
}

export function detailHeader(view: ProductView, copy: Copy): HTMLElement {
  const wrap = el("div", "sfstore__detail-head");
  const tile = markEl({
    socialImageUrl: view.socialImageUrl,
    iconUrl: view.iconUrl,
    initial: initialOf(view.name),
    large: true,
  });

  const main = el("div", "sfstore__detail-main");
  main.append(el("h3", "sfstore__detail-name", view.name));
  const tags = el("p", "sfstore__detail-tags");
  tags.append(mono(view.extensionId), badge(view.kindLabel));
  if (view.latestVersion) tags.append(badge(`v${view.latestVersion}`));
  if (view.categoryLabel) tags.append(badge(view.categoryLabel, "muted"));
  if (view.installed) {
    tags.append(badge(view.installed.versionLabel, "ok"));
    if (view.installed.updateLabel) tags.append(badge(view.installed.updateLabel, "accent"));
  }
  main.append(tags);
  if (view.summary) main.append(el("p", "sfstore__summary", view.summary));
  if (view.platforms.length) {
    main.append(el("p", "sfstore__hint", copy.t("platformsInline", { list: view.platforms.join(" · ") })));
  }
  // 宿主状态只在详情作次要说明（例如已停用）；卡片不展开它。
  if (view.installed?.statusNote) {
    main.append(el("p", "sfstore__hint", view.installed.statusNote));
  }

  wrap.append(tile, main);
  return wrap;
}

export function signedBlock(signed: InstallUrlResponseDto, copy: Copy): HTMLElement {
  const wrap = el("div", "sfstore__signed");

  const linkInput = el("input", "sfstore__input sfstore__input--mono") as HTMLInputElement;
  linkInput.type = "text";
  linkInput.readOnly = true;
  linkInput.value = signed.url;
  linkInput.setAttribute("data-role", "signed-url");
  linkInput.setAttribute("aria-label", copy.t("signedUrlLabel"));
  wrap.append(fieldEl(copy.t("signedUrlLabel"), linkInput));

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

export function stagedBlock(result: HostInstallResult, copy: Copy): HTMLElement {
  const wrap = el("div", "sfstore__staged");
  wrap.append(el("p", "sfstore__status-title", copy.t("stagedTitle")));

  const list = el("dl", "sfstore__kv");
  list.append(
    kvRow(copy.t("labelExtensionId"), result.extensionId),
    kvRow(copy.t("labelVersion"), result.version),
    kvRow(copy.t("labelDigest"), result.packageDigest, true),
  );
  wrap.append(list);

  wrap.append(el("p", "sfstore__note", copy.t("trustNote")));
  if (result.upgraded) wrap.append(el("p", "sfstore__hint", copy.t("stagedUpgradedHint")));
  if (result.requiresTrust) {
    wrap.append(el("p", "sfstore__hint", copy.t("stagedTrustHint")));
  }

  const coreButton = buttonEl(copy.t("openCoreAction"), "primary");
  coreButton.setAttribute("data-action", "open-core");
  wrap.append(coreButton);
  return wrap;
}

export function kvRow(label: string, value: string, wrapValue = false): HTMLElement {
  const row = el("div", "sfstore__kv-row");
  row.append(el("dt", "sfstore__kv-key", label));
  const cell = el("dd", "sfstore__kv-value");
  cell.append(mono(value, value));
  if (wrapValue) cell.classList.add("sfstore__kv-value--wrap");
  row.append(cell);
  return row;
}

export function notesBlock(view: ProductView, version: string, copy: Copy): HTMLElement | null {
  const release = findRelease(view, version);
  if (!release || !release.notes) return null;
  const block = el("div", "sfstore__block");
  block.append(el("h4", "sfstore__block-title", copy.t("notesTitle", { version: release.version })));
  block.append(el("p", "sfstore__prose", release.notes));
  return block;
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
  block.append(el("h4", "sfstore__block-title", copy.t("readmeTitle")));

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
  const block = el("div", "sfstore__block");
  block.append(el("h4", "sfstore__block-title", copy.t("versionsTitle")));

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
  block.append(wrap);
  return block;
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
    digestCell.append(mono(release.digestPrefix));
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
