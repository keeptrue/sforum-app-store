/**
 * Dashboard DTOs. These are the wire shapes of `/api/dashboard/products*`; the route
 * handlers serialize them as-is, so any renaming happens here and nowhere else.
 */

export type ProductKind = "plugin" | "theme";

export type ProductStatus =
  | "draft"
  | "pending_review"
  | "published"
  | "rejected"
  | "delisted";

export type DashboardProduct = {
  id: string;
  slug: string;
  extensionId: string;
  name: string;
  kind: ProductKind;
  status: ProductStatus;
  category: string | null;
  tags: string[];
  /**
   * Content-addressed URL of the GitHub social preview, or null while the product has none.
   * There is no upload path: the store fetches this, the developer never picks it.
   */
  previewUrl: string | null;
  repoId: number | null;
  /** Latest moderation rejection reason, so the owner knows what to fix. */
  reviewReason: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The cached README as the dashboard shows it: rendered, plus where it came from. */
export type DashboardReadme = {
  path: string;
  /** `https://github.com/<owner>/<repo>/blob/HEAD/<path>`. */
  sourceUrl: string;
  blobSha: string;
  fetchedAt: string;
  byteSize: number;
  /** Sanitised HTML; the only representation the dashboard renders. */
  html: string;
  /** Last refresh failure while `html` is still the previous good copy. */
  fetchError: string | null;
};

export type ReleaseVersionState =
  | "candidate"
  | "pending_review"
  | "published"
  | "rejected"
  | "yanked"
  | "needs_attention";

/** One row of the version table on the dashboard; assets stay out of it on purpose. */
export type DashboardVersion = {
  id: string;
  version: string;
  channel: "stable" | "beta";
  state: ReleaseVersionState;
  sforumVersion: string;
  capabilities: string[];
  /** Manifest display metadata; absent on versions synced before it was captured. */
  manifestDescription?: string | null;
  manifestUrl?: string | null;
  manifestAuthorName?: string | null;
  manifestAuthorUrl?: string | null;
  publishedAt: string | null;
  yankedAt: string | null;
  yankReason: string | null;
  createdAt: string;
  assetPlatforms: { os: string; arch: string }[];
};

/**
 * One brand slot as the dashboard shows it. `url` is the content-addressed address, `source`
 * says which file produced it, and `note`/`error` are the two failure flavours: a skipped
 * brand file with a working fallback (`note`), and a refresh that left the old picture in
 * place (`error`).
 */
export type DashboardBrandIcon = {
  url: string | null;
  sha256: string | null;
  /** Which file produced the mark; null while there is none. */
  source: "brand_icon" | "social_preview" | null;
  fetchedAt: string | null;
  /** Why `brand/icon.png` was skipped even though a fallback mark exists. */
  note: string | null;
  /** Last refresh failure that left the previous mark in place. */
  error: string | null;
};

export type DashboardBrandSocial = {
  url: string | null;
  sha256: string | null;
  fetchedAt: string | null;
  error: string | null;
};

export type DashboardBrand = {
  /** The square mark used by cards and page headers. */
  icon: DashboardBrandIcon;
  /** `brand/social-preview.png`, used only as the product page's Open Graph image. */
  social: DashboardBrandSocial;
};

export type DashboardProductDetail = DashboardProduct & {
  defaultLocale: string;
  summary: string;
  brand: DashboardBrand;
  /** Null until the repository has been read at least once. */
  readme: DashboardReadme | null;
  versions: DashboardVersion[];
  /** First publication; null until a moderator approves the product. */
  publishedAt: string | null;
  /** Review snapshot, so the UI can explain why a new version is held. */
  nameAtReview: string | null;
  repoIdReviewed: number | null;
  /** When and how the repository binding was established; both null while unbound. */
  repoBoundAt: string | null;
  repoBoundVia: "installation" | "github_identity" | null;
  capabilitiesReviewed: string[];
};

/**
 * Editable fields only. A product's name and introduction come from GitHub (manifest and
 * README), so the summary is the one piece of prose a developer still writes.
 */
export type ProductPatch = {
  summary?: string;
  category?: string | null;
  tags?: string[];
};
