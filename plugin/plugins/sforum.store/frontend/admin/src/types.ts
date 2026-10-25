// Wire types mirror `schemas/*.json` and the pieces of Admin Micro-frontend API v1
// this page uses. The plugin bundle has no codegen dependency, so the schema files
// stay the contract; these declarations only describe what the page reads.

export type Kind = "plugin" | "theme";

export type PlatformDto = {
  os: string;
  arch: string;
};

export type CompatibilityStatus = "compatible" | "incompatible" | "unknown";

export type CompatibilityDto = {
  status: CompatibilityStatus;
  estimated: boolean;
  constraint?: string;
};

export type CatalogItemDto = {
  slug: string;
  extensionId: string;
  name: string;
  kind: Kind;
  summary: string;
  category?: string | null;
  iconUrl?: string | null;
  latestVersion: string;
  /** 清单里的宿主约束，原样透出；上游没给就是空串。 */
  sforumVersion: string;
  updatedAt?: string;
  platforms: PlatformDto[];
  compatibility: CompatibilityDto;
};

export type CatalogResponseDto = {
  items: CatalogItemDto[];
  total: number;
  nextCursor?: string | null;
  compatibility: CompatibilityDto;
  /** 插件后端所在平台（安装目标就是服务器，不是浏览器）。 */
  target?: PlatformDto | null;
  stale?: boolean;
  fetchedAt?: string;
};

/**
 * `ProductDetail.readme`: the README of the bound repository, already rendered and
 * sanitised by the store. `html` is the only representation the page gets — there is
 * no markdown source and no client-side rendering. `null` means the store has not
 * managed to read the README yet.
 */
export type ReadmeDto = {
  html: string;
  sourceUrl: string;
  sha: string | null;
  fetchedAt: string;
  byteSize: number | null;
};

export type AssetDto = {
  os: string;
  arch: string;
  filename: string;
  size: number;
  sha256: string;
};

export type ReleaseDto = {
  version: string;
  channel: "stable" | "beta";
  publishedAt: string;
  sforumVersion: string;
  status: string;
  digest?: string;
  notes?: string | null;
  capabilities?: string[];
  assets?: AssetDto[];
};

export type ProductDto = {
  slug: string;
  extensionId: string;
  name: string;
  kind: Kind;
  summary: string;
  category?: string | null;
  iconUrl?: string | null;
  repoUrl?: string | null;
  latestVersion?: string;
  readme: ReadmeDto | null;
  platforms?: PlatformDto[];
  releases: ReleaseDto[];
};

export type ProductResponseDto = {
  product: ProductDto;
  stale?: boolean;
  fetchedAt?: string;
};

export type InstallUrlResponseDto = {
  url: string;
  sha256: string;
  size: number;
  expiresAt: string;
};

/** Host-mediated install request (`AdminHostInstallRequest` in @sforum/admin-sdk@1). */
export type HostInstallRequest = {
  url: string;
  sha256: string;
  expectedExtensionId: string;
  expectedType: Kind;
  expectedVersion?: string;
};

/** Host-mediated install result; a successful result means the package is staged. */
export type HostInstallResult = {
  extensionId: string;
  version: string;
  type: Kind;
  packageDigest: string;
  upgraded: boolean;
  requiresTrust: boolean;
};

export type ToastInput = {
  title: string;
  description?: string;
  kind?: "success" | "error";
};

/**
 * The subset of `AdminPageBridgeV1` this page relies on. `installExtension` is
 * optional by contract: only a page that declared `hostActions:
 * ["extension.install"]` on a Host that supports the action receives it.
 */
export type PageBridge = {
  request<T = unknown>(path: string, options?: Record<string, unknown>): Promise<T>;
  toast?: (input: ToastInput) => void;
  navigate?: (adminPath: string) => Promise<unknown> | unknown;
  installExtension?: (request: HostInstallRequest) => Promise<HostInstallResult>;
  locale?: string;
};

// ---------- view models ----------

export type CompatibilityView = {
  /** Copy from the page table (兼容 / 不兼容 / 按开发版估算 and their en-US forms). */
  label: string;
  tone: "ok" | "bad" | "warn";
};

/** A manifest constraint as one chip: the text that fits, plus the untruncated value. */
export type ConstraintChipView = {
  text: string;
  title: string;
};

export type CatalogItemView = {
  slug: string;
  extensionId: string;
  name: string;
  kind: Kind;
  kindLabel: string;
  summary: string;
  categoryLabel: string;
  latestVersion: string;
  /** 最新版本的 sforumVersion 约束：产品事实，替代「无判决」的兼容徽标。 */
  constraint: ConstraintChipView | null;
  platformLabels: string[];
  /**
   * Null when this page has no verdict to give. The host never reports its version
   * (SForum D9), so a row-level 兼容/不兼容 badge would be a constant, and a
   * 「未校验」 badge in the product's own slot reads like a trust verdict.
   */
  compatibility: CompatibilityView | null;
  /**
   * Absolute URL of the store-hosted mark, or null. The store turns its own
   * `/api/assets/<sha>` into an absolute address because a relative one would resolve
   * against the forum; the picture itself is public and content-addressed, so the browser
   * loads it straight from the store. A failed load falls back to `initial` — the panel must
   * never show a broken image.
   */
  iconUrl: string | null;
  /** Letter tile: the first character of the name, shown when there is no icon. */
  initial: string;
};

export type PlatformOption = {
  os: string;
  arch: string;
  label: string;
};

export type ReleaseView = {
  version: string;
  channel: "stable" | "beta";
  channelLabel: string;
  publishedAt: string;
  publishedLabel: string;
  sforumVersion: string;
  status: string;
  statusLabel: string;
  /** Only a published release with at least one asset can be handed to install-url. */
  installable: boolean;
  digestPrefix: string;
  capabilities: string[];
  notes: string;
  platforms: PlatformOption[];
};

export type ProductView = {
  slug: string;
  extensionId: string;
  name: string;
  kind: Kind;
  kindLabel: string;
  summary: string;
  /** Already-rendered README, or null when the store has none yet. */
  readme: ReadmeDto | null;
  categoryLabel: string;
  /** Absolute store-hosted mark, or null (letter tile). See `CatalogItemView.iconUrl`. */
  iconUrl: string | null;
  latestVersion: string;
  releases: ReleaseView[];
  platforms: string[];
};
