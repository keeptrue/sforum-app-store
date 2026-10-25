// Pure request/DTO logic for the store admin page: no DOM, no network, so it can be
// unit-tested without a browser. Everything the page sends or reads is built here.

import { INSTALL_FAILURE_EN, INSTALL_FAILURE_ZH, ZH_COPY } from "./copy";
import type { Copy, CopyKey } from "./copy";
import type {
  AssetDto,
  CatalogItemDto,
  CatalogItemView,
  CatalogResponseDto,
  CompatibilityDto,
  CompatibilityView,
  ConstraintChipView,
  HostInstallRequest,
  InstalledExtension,
  InstalledView,
  InstallUrlResponseDto,
  Kind,
  PlatformDto,
  PlatformOption,
  ProductDto,
  ProductView,
  ReadmeDto,
  ReleaseDto,
  ReleaseView,
} from "./types";

/** Plugin routes, exactly as declared in sforum.extension.json / openapi/routes.yaml. */
export const CATALOG_PATH = "/api/store/catalog";
export const PRODUCT_PATH = "/api/store/product";
export const INSTALL_URL_PATH = "/api/store/install-url";

/**
 * Core admin pages are Host-relative child paths: `bridge.navigate` prefixes the
 * configured admin route prefix (`/control-panel` or `/admin`) itself, so passing
 * `/admin/...` would produce `/control-panel/admin/...`.
 */
export const CORE_PLUGINS_PATH = "/extensions/plugins";
export const CORE_THEMES_PATH = "/extensions/themes";
export const CORE_INSTALL_PATH = "/extensions/install";

export const DIGEST_PREFIX_LENGTH = 12;

export type ChannelChoice = "stable" | "all";

/**
 * 兼容性过滤口径。`compatible` 是后端的默认值，所以页面不发送它；`all` 才显式追加
 * `compat=all`。宿主没给版本时后端本来就不过滤，页面也把开关藏起来（见 catalog.ts）。
 */
export type CompatMode = "compatible" | "all";

/** 「含预发布」 sends no `channel` at all: the store counts both channels when the
 * parameter is absent, while `channel=beta` would hide every stable release. */
export function channelOptions(copy: Copy = ZH_COPY): Array<{ value: ChannelChoice; label: string }> {
  return [
    { value: "stable", label: copy.t("channelStable") },
    { value: "all", label: copy.t("channelAll") },
  ];
}

// Mirrors service/src/lib/products/taxonomy.ts (the store owns these keys; the
// bundle cannot import them). `category` is passed through and matched exactly.
const CATEGORY_KEYS: ReadonlyArray<{ value: string; key: CopyKey }> = [
  { value: "", key: "categoryAll" },
  { value: "content", key: "categoryContent" },
  { value: "appearance", key: "categoryAppearance" },
  { value: "community", key: "categoryCommunity" },
  { value: "integration", key: "categoryIntegration" },
  { value: "ops", key: "categoryOps" },
  { value: "security", key: "categorySecurity" },
];

export function categoryOptions(copy: Copy = ZH_COPY): Array<{ value: string; label: string }> {
  return CATEGORY_KEYS.map((entry) => ({ value: entry.value, label: copy.t(entry.key) }));
}

// ---------- request building ----------

export type CatalogQueryInput = {
  query: string;
  channel: ChannelChoice;
  category: string;
  cursor: string | null;
  compatMode: CompatMode;
};

/** `GET /api/store/catalog` with the parameter order the plugin backend proxies. */
export function buildCatalogPath(input: CatalogQueryInput): string {
  const params = new URLSearchParams();
  // `compatible` 是后端默认值：只在「全部」时显式发出去，免得两份默认值各说各话。
  if (input.compatMode === "all") params.set("compat", "all");
  if (input.channel === "stable") params.set("channel", "stable");
  const query = input.query.trim();
  if (query) params.set("q", query);
  if (input.category) params.set("category", input.category);
  if (input.cursor) params.set("cursor", input.cursor);
  const search = params.toString();
  return search ? `${CATALOG_PATH}?${search}` : CATALOG_PATH;
}

export function buildProductPath(slug: string): string {
  return `${PRODUCT_PATH}?slug=${encodeURIComponent(slug)}`;
}

/** Body of `POST /api/store/install-url`, matching schemas/install-url.request.json. */
export function buildInstallUrlBody(input: { slug: string; version: string; os: string; arch: string }) {
  return { slug: input.slug, version: input.version, os: input.os, arch: input.arch };
}

/** The exact object handed to `bridge.installExtension`. */
export function buildInstallRequest(input: {
  signed: InstallUrlResponseDto;
  product: { extensionId: string; kind: Kind };
  version: string;
}): HostInstallRequest {
  return {
    url: input.signed.url,
    sha256: input.signed.sha256,
    expectedExtensionId: input.product.extensionId,
    expectedType: input.product.kind,
    expectedVersion: input.version,
  };
}

// ---------- failure reading ----------

export type RequestFailure = {
  status: number;
  code: string;
  message: string;
};

export type FailureKind = "not_configured" | "failed";

type Record_ = Record<string, unknown>;

function asRecord(value: unknown): Record_ | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record_) : undefined;
}

function firstString(values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstNumber(values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

/**
 * Reads a failure from the shapes this host can produce:
 * - the plugin route's own body (`{code: "not_configured", message}`), thrown by `$fetch`;
 * - the Host envelope (`{code: 503, message, data: {reason}}`);
 * - a plain `Error` with no body at all.
 */
export function readFailure(error: unknown): RequestFailure {
  const root = asRecord(error) ?? {};
  const response = asRecord(root.response);
  const body = asRecord(root.data) ?? asRecord(response?._data) ?? {};
  const nested = asRecord(body.data);
  const envelopeData = asRecord(asRecord(response?._data)?.data);
  const code = firstString([
    nested?.reason,
    nested?.code,
    body.reason,
    typeof body.code === "string" ? body.code : "",
    envelopeData?.reason,
    root.reason,
    typeof root.code === "string" ? root.code : "",
  ]);
  const status = firstNumber([
    root.statusCode,
    root.status,
    response?.status,
    typeof body.code === "number" ? body.code : 0,
  ]);
  const message = firstString([nested?.message, body.message, envelopeData?.message, root.message]);
  return { status, code, message };
}

export type FailureClass = {
  kind: FailureKind;
  status: number;
  code: string;
  detail: string;
};

/** `not_configured` (HTTP 503 from the plugin) drives the calm setup state. */
export function classifyFailure(error: unknown): FailureClass {
  const failure = readFailure(error);
  const notConfigured =
    failure.status === 503 ||
    failure.code === "not_configured" ||
    /not_configured/.test(failure.message);
  return {
    kind: notConfigured ? "not_configured" : "failed",
    status: failure.status,
    code: failure.code,
    detail:
      failure.message ||
      failure.code ||
      (failure.status ? `HTTP ${failure.status}` : ""),
  };
}

/** Copy for every stable install failure code, plus the identity mismatch (zh-CN). */
export const INSTALL_FAILURE_TEXT: Readonly<Record<string, string>> = INSTALL_FAILURE_ZH;

/** Same table for en-US; kept exported so tests can assert both locales' shapes. */
export const INSTALL_FAILURE_TEXT_EN: Readonly<Record<string, string>> = INSTALL_FAILURE_EN;

/**
 * Maps an `AdminHostInstallError` to copy. The Host rejects with a stable
 * `error.code`; `extension.expected_mismatch` is compared before the type
 * permission switch and may arrive as the reason inside a failed attempt.
 */
export function installFailureText(error: unknown, copy: Copy = ZH_COPY): string {
  const failure = readFailure(error);
  const known = copy.failure[failure.code];
  if (known) return known;
  const suffix = failure.code || (failure.status ? `HTTP ${failure.status}` : "");
  return suffix ? copy.t("installFailedWithCode", { code: suffix }) : copy.t("installFailed");
}

export function installFailureCode(error: unknown): string {
  return readFailure(error).code;
}

// ---------- payload parsing ----------

/**
 * `bridge.request` resolves through the Host API client, which returns the
 * envelope's `data`. The plugin route body is written through unchanged, so the
 * page accepts both `{items…}` and `{data: {items…}}` rather than betting on one.
 */
export function unwrapDocument(payload: unknown): Record_ {
  const outer = asRecord(payload) ?? {};
  const inner = asRecord(outer.data);
  if (outer.items !== undefined || outer.product !== undefined || outer.url !== undefined) return outer;
  if (inner) return inner;
  return outer;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function stringOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function normalizeCompatibility(value: unknown): CompatibilityDto {
  const record = asRecord(value) ?? {};
  const status = record.status;
  return {
    status: status === "compatible" || status === "incompatible" ? status : "unknown",
    estimated: record.estimated === true,
    ...(typeof record.constraint === "string" ? { constraint: record.constraint } : {}),
  };
}

/**
 * 内容寻址资产地址（封面 / 图标）。商城已经拼成绝对地址，这里只放行 http(s)：
 * `javascript:` / `data:` 之类不该进 `<img src>`，不合法一律当「没有」，页面会走下一级回退。
 */
function normalizeAssetUrl(value: unknown): string | null {
  const url = stringOr(value).trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * 宿主已装清单条目。没有版本号的 `installed` 撑不起「已安装 v…」这句话，按未装处理：
 * 宁可少一个徽标，也不在页面上写一句查不到出处的话。
 */
function normalizeInstalled(value: unknown): InstalledExtension | null {
  const record = asRecord(value);
  if (!record) return null;
  const version = stringOr(record.version).trim();
  if (!version) return null;
  return { version, status: stringOr(record.status).trim() };
}

function normalizePlatforms(value: unknown): PlatformDto[] {
  if (!Array.isArray(value)) return [];
  const result: PlatformDto[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const os = stringOr(record?.os).trim();
    const arch = stringOr(record?.arch).trim();
    if (!os || !arch) continue;
    if (result.some((item) => item.os === os && item.arch === arch)) continue;
    result.push({ os, arch });
  }
  return result;
}

function normalizeItem(value: unknown): CatalogItemDto | null {
  const record = asRecord(value);
  if (!record) return null;
  const slug = stringOr(record.slug).trim();
  const name = stringOr(record.name).trim();
  if (!slug || !name) return null;
  const kind: Kind = record.kind === "theme" ? "theme" : "plugin";
  return {
    slug,
    extensionId: stringOr(record.extensionId).trim(),
    name,
    kind,
    summary: stringOr(record.summary).trim(),
    category: typeof record.category === "string" ? record.category : null,
    iconUrl: normalizeAssetUrl(record.iconUrl),
    socialImageUrl: normalizeAssetUrl(record.socialImageUrl),
    installed: normalizeInstalled(record.installed),
    // 旧后端没有这个字段：false 而不是 undefined，视图层不必再猜。
    updateAvailable: record.updateAvailable === true,
    latestVersion: stringOr(record.latestVersion).trim(),
    sforumVersion: stringOr(record.sforumVersion).trim(),
    updatedAt: stringOr(record.updatedAt),
    platforms: normalizePlatforms(record.platforms),
    compatibility: normalizeCompatibility(record.compatibility),
  };
}

export function parseCatalog(payload: unknown): CatalogResponseDto {
  const document = unwrapDocument(payload);
  if (!Array.isArray(document.items)) throw new Error("catalog payload has no items");
  const items: CatalogItemDto[] = [];
  for (const entry of document.items) {
    const item = normalizeItem(entry);
    if (item) items.push(item);
  }
  return {
    items,
    total: numberOr(document.total, items.length),
    nextCursor: typeof document.nextCursor === "string" && document.nextCursor ? document.nextCursor : null,
    compatibility: normalizeCompatibility(document.compatibility),
    target: normalizeTarget(document.target),
    stale: document.stale === true,
    fetchedAt: stringOr(document.fetchedAt),
  };
}

function normalizeAssets(value: unknown): AssetDto[] {
  if (!Array.isArray(value)) return [];
  const assets: AssetDto[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const os = stringOr(record?.os).trim();
    const arch = stringOr(record?.arch).trim();
    if (!os || !arch) continue;
    assets.push({
      os,
      arch,
      filename: stringOr(record?.filename).trim(),
      size: numberOr(record?.size, 0),
      sha256: stringOr(record?.sha256).trim(),
    });
  }
  return assets;
}

function normalizeRelease(value: unknown): ReleaseDto | null {
  const record = asRecord(value);
  if (!record) return null;
  const version = stringOr(record.version).trim();
  if (!version) return null;
  const channel = record.channel === "beta" ? "beta" : "stable";
  return {
    version,
    channel,
    publishedAt: stringOr(record.publishedAt),
    sforumVersion: stringOr(record.sforumVersion).trim(),
    status: stringOr(record.status).trim(),
    digest: stringOr(record.digest).trim(),
    notes: typeof record.notes === "string" ? record.notes : null,
    capabilities: Array.isArray(record.capabilities)
      ? record.capabilities.filter((item): item is string => typeof item === "string")
      : [],
    assets: normalizeAssets(record.assets),
  };
}

/**
 * `readme` is `{html, sourceUrl, sha, fetchedAt, byteSize} | null`. The store always
 * sends the rendered HTML; the page never renders markdown itself. A missing or
 * wrongly-typed required field means "not readable yet" and collapses to null, so the
 * detail view shows its placeholder instead of half a README.
 */
export function normalizeReadme(value: unknown): ReadmeDto | null {
  const record = asRecord(value);
  if (!record) return null;
  const html = stringOr(record.html);
  const sourceUrl = stringOr(record.sourceUrl).trim();
  const fetchedAt = stringOr(record.fetchedAt).trim();
  if (!html.trim() || !sourceUrl || !fetchedAt) return null;
  const sha = stringOr(record.sha).trim();
  const byteSize =
    typeof record.byteSize === "number" && Number.isFinite(record.byteSize) && record.byteSize >= 0
      ? record.byteSize
      : null;
  return { html, sourceUrl, sha: sha || null, fetchedAt, byteSize };
}

export function parseProduct(payload: unknown): ProductDto {
  const document = unwrapDocument(payload);
  const record = asRecord(document.product);
  if (!record) throw new Error("product payload has no product");
  const slug = stringOr(record.slug).trim();
  const name = stringOr(record.name).trim();
  if (!slug || !name) throw new Error("product payload has no identity");
  const releases: ReleaseDto[] = [];
  if (Array.isArray(record.releases)) {
    for (const entry of record.releases) {
      const release = normalizeRelease(entry);
      if (release) releases.push(release);
    }
  }
  return {
    slug,
    extensionId: stringOr(record.extensionId).trim(),
    name,
    kind: record.kind === "theme" ? "theme" : "plugin",
    summary: stringOr(record.summary).trim(),
    category: typeof record.category === "string" ? record.category : null,
    iconUrl: normalizeAssetUrl(record.iconUrl),
    socialImageUrl: normalizeAssetUrl(record.socialImageUrl),
    installed: normalizeInstalled(record.installed),
    updateAvailable: record.updateAvailable === true,
    repoUrl: typeof record.repoUrl === "string" ? record.repoUrl : null,
    latestVersion: stringOr(record.latestVersion).trim(),
    readme: normalizeReadme(record.readme),
    platforms: normalizePlatforms(record.platforms),
    releases,
  };
}

export function parseInstallUrl(payload: unknown): InstallUrlResponseDto {
  const document = unwrapDocument(payload);
  const url = stringOr(document.url).trim();
  const sha256 = stringOr(document.sha256).trim();
  if (!url || !sha256) throw new Error("install-url payload is incomplete");
  return {
    url,
    sha256,
    size: numberOr(document.size, 0),
    expiresAt: stringOr(document.expiresAt),
  };
}

// ---------- view mapping ----------

export function platformLabel(platform: PlatformDto, copy: Copy = ZH_COPY): string {
  if (platform.os === "any" && platform.arch === "any") return copy.t("platformAny");
  return `${platform.os}/${platform.arch}`;
}

export function platformLabels(platforms: PlatformDto[], copy: Copy = ZH_COPY): string[] {
  const labels: string[] = [];
  for (const platform of platforms) {
    const label = platformLabel(platform, copy);
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

export function platformOptions(platforms: PlatformDto[], copy: Copy = ZH_COPY): PlatformOption[] {
  const options: PlatformOption[] = [];
  for (const platform of platforms) {
    if (options.some((item) => item.os === platform.os && item.arch === platform.arch)) continue;
    options.push({ os: platform.os, arch: platform.arch, label: platformLabel(platform, copy) });
  }
  return options;
}

export function compatibilityView(
  input: CompatibilityDto,
  copy: Copy = ZH_COPY,
): CompatibilityView | null {
  // Same rule as the store's own card: only a real verdict earns a badge, and a dev-build
  // estimate is never phrased as one. `unknown` means the host never told anyone its
  // version, so there is nothing per-row to say — `compatibilityNote` says it once.
  if (input.estimated) return { label: copy.t("estimatedLabel"), tone: "warn" };
  if (input.status === "compatible") return { label: copy.t("compatibleLabel"), tone: "ok" };
  if (input.status === "incompatible") return { label: copy.t("incompatibleLabel"), tone: "bad" };
  return null;
}

/**
 * The catalogue's own `compatibility`, rendered once above the list. The plugin never
 * forwards a host version (SForum D9), so `unknown` is the normal case and deserves a
 * sentence instead of a badge on every row.
 *
 * 有判决时 `compatMode` 才有意义：一旦操作者切到「全部」，「已按宿主版本筛出一份可安装的
 * 目录」就不成立了，那种口径需要自己的一句说明。
 */
export function compatibilityNote(
  input: CompatibilityDto | null,
  copy: Copy = ZH_COPY,
  compatMode: CompatMode = "compatible",
): string {
  if (!input) return "";
  if (input.estimated) return copy.t("compatEstimatedNote");
  if (input.status === "unknown") return copy.t("compatUnjudgedNote");
  if (compatMode === "all") return copy.t("compatAllNote");
  return copy.t("compatFilteredNote");
}

const CONSTRAINT_CHIP_MAX = 18;

/**
 * The manifest constraint as one chip: raw text, truncated only for layout, with the full
 * value kept for `title`. Operators are never rewritten — the store's detail page prints
 * the same string, and two representations of one constraint would drift apart.
 */
export function constraintChip(
  constraint: string | null | undefined,
): ConstraintChipView | null {
  const value = (constraint ?? "").trim();
  if (!value) return null;
  const text =
    value.length > CONSTRAINT_CHIP_MAX ? `${value.slice(0, CONSTRAINT_CHIP_MAX - 1)}…` : value;
  return { text, title: value };
}

export function categoryLabel(category: string | null | undefined, copy: Copy = ZH_COPY): string {
  if (!category) return "";
  const entry = CATEGORY_KEYS.find((item) => item.value && item.value === category);
  return entry ? copy.t(entry.key) : category;
}

export function kindLabel(kind: Kind, copy: Copy = ZH_COPY): string {
  return kind === "theme" ? copy.t("kindTheme") : copy.t("kindPlugin");
}

export function initialOf(name: string): string {
  const chars = Array.from(name.trim());
  if (!chars.length) return "?";
  return chars[0].toUpperCase();
}

export function digestPrefix(digest: string, length = DIGEST_PREFIX_LENGTH): string {
  return digest.trim().slice(0, length);
}

/**
 * 宿主状态只在详情里作次要说明：`enabled` 与安装徽标重复，说不说都一样；`disabled` 与
 * `installed`（装了还没启用）才需要一句人话。其它状态原样带出，不替宿主翻译。
 */
export function installedStatusNote(status: string, copy: Copy = ZH_COPY): string | null {
  if (!status || status === "enabled") return null;
  if (status === "disabled") return copy.t("installedStatusDisabled");
  if (status === "installed") return copy.t("installedStatusUnenabled");
  return copy.t("installedStatusOther", { status });
}

/**
 * 「已安装 v…」是宿主清单里的事实，不是本页安装流程的结论；「可更新至 v…」只在后端判定
 * `updateAvailable` 且有 latestVersion 时出现。没有安装条目就不生成任何标记，哪怕后端
 * 单独发了 `updateAvailable: true`（没有已装版本，这句话就无从谈起）。
 */
export function installedView(
  input: {
    installed: InstalledExtension | null;
    latestVersion: string;
    updateAvailable: boolean;
  },
  copy: Copy = ZH_COPY,
): InstalledView | null {
  if (!input.installed) return null;
  const latest = input.latestVersion.trim();
  return {
    version: input.installed.version,
    versionLabel: copy.t("installedBadge", { version: input.installed.version }),
    updateLabel:
      input.updateAvailable && latest ? copy.t("updateBadge", { version: latest }) : null,
    status: input.installed.status,
    statusNote: installedStatusNote(input.installed.status, copy),
  };
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${formatDate(value)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function toCatalogItemView(item: CatalogItemDto, copy: Copy = ZH_COPY): CatalogItemView {
  return {
    slug: item.slug,
    extensionId: item.extensionId || item.slug,
    name: item.name,
    kind: item.kind,
    kindLabel: kindLabel(item.kind, copy),
    summary: item.summary,
    categoryLabel: categoryLabel(item.category, copy),
    latestVersion: item.latestVersion,
    constraint: constraintChip(item.sforumVersion),
    platformLabels: platformLabels(item.platforms, copy),
    compatibility: compatibilityView(item.compatibility, copy),
    socialImageUrl: item.socialImageUrl ?? null,
    iconUrl: item.iconUrl ?? null,
    initial: initialOf(item.name),
    installed: installedView(
      {
        installed: item.installed,
        latestVersion: item.latestVersion,
        updateAvailable: item.updateAvailable,
      },
      copy,
    ),
  };
}

export function statusLabel(status: string, copy: Copy = ZH_COPY): string {
  if (status === "published") return copy.t("statusPublished");
  if (status === "yanked") return copy.t("statusYanked");
  return status || copy.t("statusUnknown");
}

export function toReleaseView(release: ReleaseDto, copy: Copy = ZH_COPY): ReleaseView {
  const options = platformOptions(release.assets ?? [], copy);
  return {
    version: release.version,
    channel: release.channel,
    channelLabel: release.channel === "beta" ? copy.t("channelBeta") : copy.t("channelStable"),
    publishedAt: release.publishedAt,
    publishedLabel: formatDate(release.publishedAt),
    sforumVersion: release.sforumVersion,
    status: release.status,
    statusLabel: statusLabel(release.status, copy),
    installable: release.status === "published" && options.length > 0,
    digestPrefix: digestPrefix(release.digest ?? ""),
    capabilities: release.capabilities ?? [],
    notes: release.notes ?? "",
    platforms: options,
  };
}

export function toProductView(product: ProductDto, copy: Copy = ZH_COPY): ProductView {
  return {
    slug: product.slug,
    extensionId: product.extensionId,
    name: product.name,
    kind: product.kind,
    kindLabel: kindLabel(product.kind, copy),
    summary: product.summary,
    readme: product.readme,
    categoryLabel: categoryLabel(product.category, copy),
    socialImageUrl: product.socialImageUrl ?? null,
    iconUrl: product.iconUrl ?? null,
    installed: installedView(
      {
        installed: product.installed,
        latestVersion: product.latestVersion ?? "",
        updateAvailable: product.updateAvailable,
      },
      copy,
    ),
    latestVersion: product.latestVersion ?? "",
    releases: product.releases.map((release) => toReleaseView(release, copy)),
    platforms: platformLabels(product.platforms ?? [], copy),
  };
}

export function installableReleases(view: ProductView): ReleaseView[] {
  return view.releases.filter((release) => release.installable);
}

export function findRelease(view: ProductView, version: string): ReleaseView | null {
  return view.releases.find((release) => release.version === version) ?? null;
}

function normalizeTarget(value: unknown): PlatformDto | null {
  const record = asRecord(value);
  const os = stringOr(record?.os).trim();
  const arch = stringOr(record?.arch).trim();
  if (!os || !arch) return null;
  return { os, arch };
}

/**
 * 默认平台优先选服务器自己的平台（插件后端在服务器上跑，安装目标也是服务器），
 * 其次是 any/any（主题），最后才退回第一个资产。避免在 linux 服务器上默认选中 darwin 包。
 */
export function defaultPlatform(
  release: ReleaseView | null,
  target?: PlatformDto | null,
): PlatformOption | null {
  if (!release || !release.platforms.length) return null;
  if (target) {
    const exact = release.platforms.find(
      (option) => option.os === target.os && option.arch === target.arch,
    );
    if (exact) return exact;
  }
  const wildcard = release.platforms.find(
    (option) => option.os === "any" && option.arch === "any",
  );
  return wildcard ?? release.platforms[0];
}

export function corePathForKind(kind: Kind): string {
  return kind === "theme" ? CORE_THEMES_PATH : CORE_PLUGINS_PATH;
}
