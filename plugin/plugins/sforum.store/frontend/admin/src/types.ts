// Wire types mirror `schemas/*.json` and the pieces of Admin Micro-frontend API v1
// this page uses. The plugin bundle has no codegen dependency, so the schema files
// stay the contract; these declarations only describe what the page reads.

export type Kind = "plugin" | "theme";

/**
 * 详情弹窗的三个分区。ID 同时用作 DOM id 与 ARIA 关系的锚点，所以是稳定的英文键，
 * 不随语言变化（`aria-controls` / `aria-labelledby` 只要求同一份 DOM 内唯一）。
 */
export type DialogTabId = "readme" | "versions" | "notes";

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

/**
 * 宿主已装清单里的同名扩展（SForum `extensions` 行）。`status` 是宿主自己的生命周期词
 * （`installed` / `enabled` / `disabled`），原样透出：页面只解释它，不改写它。
 */
export type InstalledExtension = {
  version: string;
  status: string;
};

export type CatalogItemDto = {
  slug: string;
  extensionId: string;
  name: string;
  kind: Kind;
  summary: string;
  category?: string | null;
  iconUrl?: string | null;
  /**
   * 商城内容寻址的品牌分享卡（1280×640，后端已拼成绝对地址）。目录卡片把它当封面；
   * 缺失或加载失败才退回 iconUrl，再退回字母块。
   */
  socialImageUrl: string | null;
  /** 宿主已装清单里的同名扩展；null = 这台宿主没装。 */
  installed: InstalledExtension | null;
  /** 已装版本低于该产品的 latestVersion（后端判定）；页面只负责展示。 */
  updateAvailable: boolean;
  latestVersion: string;
  /** 清单里的宿主约束，原样透出；上游没给就是空串。 */
  sforumVersion: string;
  updatedAt?: string;
  /** 全部候选版本的平台并集；老商城只有这一个。 */
  platforms: PlatformDto[];
  /**
   * 卡片指向的那一版（`latestVersion`）的平台。新商城才发；缺失时页面回落 `platforms`，
   * 语义是「这一版至少覆盖这些平台」，绝不反过来把并集当成某一版的资产清单。
   */
  latestPlatforms?: PlatformDto[];
  compatibility: CompatibilityDto;
};

export type CatalogResponseDto = {
  items: CatalogItemDto[];
  total: number;
  nextCursor?: string | null;
  compatibility: CompatibilityDto;
  /**
   * 服务端回显的本次生效口径（`compat` 参数实际取到的值）。老服务端不发送这个字段，
   * 页面在 `auto` 下按 `compatibility.estimated` 推断；可选，绝不作为必需契约。
   */
  compat?: "compatible" | "all" | null;
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

/**
 * How a version compares with what this host already has. Computed by the plugin backend
 * (`mapping.go installedRelation`), because the page has no semver implementation and must
 * not grow a second one. Absent means "no inventory", which reads exactly like not installed.
 */
export type InstalledRelation = "newer" | "same" | "older" | "unknown";

export type ReleaseDto = {
  version: string;
  channel: "stable" | "beta";
  publishedAt: string;
  sforumVersion: string;
  status: string;
  digest?: string;
  /** GitHub release body, Markdown source. Kept for clients that render it themselves. */
  notes?: string | null;
  /**
   * The same body rendered and sanitised by the store (README's allow-list). Injected as-is;
   * older stores do not send it and the page falls back to the plain-text `notes`.
   */
  notesHtml?: string | null;
  installedRelation?: InstalledRelation;
  capabilities?: string[];
  assets?: AssetDto[];
};

/**
 * The maintainer block. Two independent sources: the forum account that owns the product and
 * the GitHub account the bound repository lives under. Either half may be null, and neither
 * is ever filled in from the other — see the store contract's `Author`.
 */
export type AuthorDto = {
  username?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  /** Absolute forum profile page, built by the store from the issuer base URL. */
  profileUrl?: string | null;
  github?: { login?: string; url?: string } | null;
};

export type ProductDto = {
  slug: string;
  extensionId: string;
  name: string;
  kind: Kind;
  summary: string;
  category?: string | null;
  iconUrl?: string | null;
  /** 与目录项同一份分享卡；详情头部按同一优先级展示。 */
  socialImageUrl: string | null;
  /** 宿主已装清单条目；null = 未装。 */
  installed: InstalledExtension | null;
  /** 已装版本低于 latestVersion。 */
  updateAvailable: boolean;
  repoUrl?: string | null;
  /** Null when neither a forum account nor a repository is bound. */
  author?: AuthorDto | null;
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

/**
 * What the Host reached when the page asked it to install *and* enable.
 * `staged` is an honest stop (theme, delegated operator, declined review), not a failure.
 */
export type HostInstallEnableOutcome = "enabled" | "upgraded" | "staged";

/** Same identity block as {@link HostInstallResult}, plus the outcome the Host reached. */
export type HostInstallEnableResult = HostInstallResult & { outcome: HostInstallEnableOutcome };

/**
 * Result of the install-bar gate: whether the primary action may run, and what to say when it
 * may not. `reason` is a `Copy` key, never a sentence, so both locales stay in the table.
 */
export type InstallGate =
  | { installable: true; upgrade: boolean }
  | {
      installable: false;
      reason:
        | "installedSame"
        | "installedNewer"
        | "installedUnknown"
        | "platformUnsupported"
        | "noRelease";
      installedVersion: string | null;
    };

export type ToastInput = {
  title: string;
  description?: string;
  kind?: "success" | "error";
};

/**
 * The subset of `AdminPageBridgeV1` this page relies on. Both install methods are
 * optional by contract: a Host only injects the ones whose `hostActions` this page
 * declared, and an older Host has no enable method at all.
 *
 * - `installExtension` stages the package and stops there (success = 已暂存).
 * - `installAndEnableExtension` installs and then runs the Host's own enable flow;
 *   its result carries `outcome`, so the page reports what actually happened.
 */
export type PageBridge = {
  request<T = unknown>(path: string, options?: Record<string, unknown>): Promise<T>;
  toast?: (input: ToastInput) => void;
  navigate?: (adminPath: string) => Promise<unknown> | unknown;
  installExtension?: (request: HostInstallRequest) => Promise<HostInstallResult>;
  installAndEnableExtension?: (
    request: HostInstallRequest,
  ) => Promise<HostInstallEnableResult>;
  locale?: string;
};

// ---------- view models ----------

export type CompatibilityView = {
  /**
   * Copy from the page table (兼容 / 不兼容 and their en-US forms). 徽标只放判决：
   * 「宿主是开发版」属于宿主属性，由页级说明表达，不在这里。
   */
  label: string;
  tone: "ok" | "bad";
};

/** A manifest constraint as one chip: the text that fits, plus the untruncated value. */
export type ConstraintChipView = {
  text: string;
  title: string;
};

/**
 * 「已装 / 可更新」标记。文案在这里按 `Copy` 生成，卡片与详情共用，避免两处措辞漂移。
 *
 * 它说的是**宿主清单里有什么**，不是本页把安装流程做成了什么：安装成功一律只写「已暂存」，
 * 这个徽标不得改写安装区的结论。
 */
export type InstalledView = {
  /** 宿主清单里的版本号（不含 `v` 前缀）。 */
  version: string;
  /** 「已安装 v1.2.3」 */
  versionLabel: string;
  /** 「可更新至 v1.4.2」；没有可更新版本时为 null。 */
  updateLabel: string | null;
  /** 宿主状态原文。 */
  status: string;
  /** 只在详情里出现的次要说明（已停用 / 尚未启用 / 其它状态）；无需说明时为 null。 */
  statusNote: string | null;
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
   * 商城托管的品牌分享卡绝对地址（1280×640），封面用；加载失败退到 `iconUrl`，再退到字母块，
   * 所以面板上不会出现破图。
   */
  socialImageUrl: string | null;
  /**
   * Absolute URL of the store-hosted mark, or null. The store turns its own
   * `/api/assets/<sha>` into an absolute address because a relative one would resolve
   * against the forum; the picture itself is public and content-addressed, so the browser
   * loads it straight from the store. A failed load falls back to `initial` — the panel must
   * never show a broken image.
   */
  iconUrl: string | null;
  /** Letter tile: the first character of the name, shown when there is no picture at all. */
  initial: string;
  /** 已装 / 可更新标记；未装时为 null。 */
  installed: InstalledView | null;
  /**
   * 卡片指向的那一版能不能在当前架构上跑。`null` = 页面没有基准（老商城不回 target）或
   * 上游没给平台信息，此时不画徽标 —— 未知不是「不支持」。
   */
  supported: boolean | null;
  /** 全部候选版本的并集能不能跑：用来区分「最新版不支持」和「全都不支持」。 */
  supportedAnywhere: boolean | null;
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
  /** 这一版的资产里有没有当前架构（`any/any` 通配）；`null` = 没有基准可判。 */
  supported: boolean | null;
  /**
   * How this version compares with the installed one, or null when the host inventory is
   * unavailable. `installGate` turns it into the install-bar decision.
   */
  relation: InstalledRelation | null;
  /** Human wording for `relation` (「已安装」「低于已安装」…), or null when there is none. */
  relationLabel: string | null;
  /** Rendered notes HTML when the store provides it; empty string means "use `notes`". */
  notesHtml: string;
  digestPrefix: string;
  /** 完整制品摘要：版本表只展示 12 位前缀，完整值放 `title`。 */
  digest?: string;
  capabilities: string[];
  notes: string;
  platforms: PlatformOption[];
};

/**
 * Author strip view model. `name` is what the strip prints next to the avatar (display name,
 * falling back to the login), `handle` is the exact forum login when it differs, and
 * `github` is a ready-made link to the repository's owner account.
 */
export type AuthorView = {
  name: string;
  /** Whether a forum account exists at all (the name line then carries a forum identity). */
  hasForum: boolean;
  handle: string | null;
  /** Forum profile page for that handle, or null when the store has no issuer URL. */
  profileUrl: string | null;
  avatarUrl: string | null;
  initial: string;
  github: { login: string; url: string } | null;
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
  /** Null when neither source exists; the strip is then not rendered at all. */
  author: AuthorView | null;
  categoryLabel: string;
  /** 与目录项同一份分享卡；详情头部按同一优先级展示。 */
  socialImageUrl: string | null;
  /** Absolute store-hosted mark, or null (letter tile). See `CatalogItemView.iconUrl`. */
  iconUrl: string | null;
  /** 已装 / 可更新标记；未装时为 null。 */
  installed: InstalledView | null;
  latestVersion: string;
  releases: ReleaseView[];
  platforms: string[];
};
