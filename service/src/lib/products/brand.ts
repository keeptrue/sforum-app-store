import { eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import { products, type BrandSource } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { requireGithubConfig } from "@/lib/github/app-config";
import {
  BRAND_ICON_FILE,
  BRAND_ICON_MAX_BYTES,
  BRAND_SOCIAL_FILE,
  BRAND_SOCIAL_MAX_BYTES,
  fetchBrandFile,
  locateBrandDir,
  type BrandFileResult,
  type BrandLayout,
  type BrandLayoutReader,
} from "@/lib/github/brand";
import { GithubAppClient } from "@/lib/github/client";
import { loadRepoTarget } from "@/lib/github/readme";
import {
  fetchSocialPreview,
  type SocialPreviewFailure,
} from "@/lib/github/social-preview";
import { validateImage } from "@/lib/storage/image";
import { LocalAssetStore } from "@/lib/storage/local";
import { updateProductBrand, upsertAsset } from "./store";

/**
 * Refresh a product's brand assets from its repository.
 *
 * Two slots, two jobs:
 *
 * - **mark** (`products.preview_*`) — the square icon on cards and page headers. Source
 *   order is the package's `brand/icon.png` (the host contract's own file) → GitHub's
 *   repository social preview → nothing. The fallback is not politeness: most repositories
 *   never adopted the brand layout, and a letter tile for all of them would be a regression.
 * - **social card** (`products.og_*`) — the package's `brand/social-preview.png`, served only
 *   as the product page's Open Graph image. A 1280×640 card is useless as an icon and a 512
 *   square is useless in a link preview, so the two never share a slot.
 *
 * **Where `brand/` is:** inside the extension package, next to `sforum.extension.json` —
 * which is the repository root for a standalone package and
 * `plugins/<name>/` for a repository that ships its package in a subdirectory. The layout is
 * resolved once per refresh and shared by both slots (`lib/github/brand.ts:locateBrandDir`).
 *
 * Discipline, inherited from the social-preview fetcher:
 *
 * - the bytes come from the bound repository through the installation token, so private
 *   repositories work; no caller-supplied address ever reaches the network;
 * - everything is stored content-addressed, so no response carries an upstream URL;
 * - **a failure never blanks the mark.** A stale picture beats a card that flickers to a
 *   letter tile, and the reason is written to `preview_error` for the dashboard to show;
 * - the blob sha is compared first: an unchanged file costs one contents call and no
 *   download.
 */

export type BrandNote =
  | "brand_not_png"
  | "brand_not_square"
  | "brand_too_large"
  | "brand_invalid_image"
  | "brand_not_a_file"
  | "brand_read_failed"
  | "brand_layout_ambiguous";

export type IconRefreshOutcome = {
  ok: boolean;
  /** Which source the stored mark came from; null when nothing was stored. */
  source: BrandSource | null;
  sha256: string | null;
  fetchedAt: string | null;
  /** Why `brand/icon.png` was skipped while a mark still exists. */
  note: BrandNote | null;
  /** Final failure code when `ok` is false. */
  reason: string | null;
  changed: boolean;
};

export type SocialRefreshOutcome = {
  ok: boolean;
  sha256: string | null;
  fetchedAt: string | null;
  reason: string | null;
  changed: boolean;
};

export type BrandRefreshResult = {
  icon: IconRefreshOutcome;
  social: SocialRefreshOutcome;
};

/** Upload-style rejection codes for the `brand/social-preview.png` slot. */
export type SocialNote =
  | "social_not_png"
  | "social_bad_ratio"
  | "social_too_large"
  | "social_invalid_image";

/** 1280×640 is 2:1; a hand-made card may be a few pixels off and still look right. */
const SOCIAL_ASPECT = 2;
const SOCIAL_ASPECT_TOLERANCE = 0.05;

export type IconAdmission =
  | { ok: true; mime: "image/png"; width: number; height: number }
  | { ok: false; note: BrandNote };

/**
 * What the store accepts as a mark: any square PNG up to 1 MiB.
 *
 * Deliberately looser than the host contract (`brand/icon.png` = 512×512, ≤120 KiB). The
 * host's `extension brand check` is the gate for the package; the catalog only needs an
 * image it can draw, and rejecting a 600×600 icon would leave a published product with no
 * mark over a rule the store does not enforce anywhere else.
 */
export async function admitBrandIcon(bytes: Uint8Array): Promise<IconAdmission> {
  const base = await validateImage(bytes);
  if (!base.ok) {
    if (base.code === "image_too_large") return { ok: false, note: "brand_too_large" };
    if (base.code === "image_dimensions_too_large") {
      return { ok: false, note: "brand_invalid_image" };
    }
    return { ok: false, note: "brand_not_png" };
  }
  if (base.mime !== "image/png") return { ok: false, note: "brand_not_png" };
  if (base.width !== base.height) return { ok: false, note: "brand_not_square" };
  return { ok: true, mime: "image/png", width: base.width, height: base.height };
}

export type SocialAdmission =
  | { ok: true; mime: "image/png"; width: number; height: number }
  | { ok: false; note: SocialNote };

/** The link-preview card: PNG, roughly 2:1, up to 1 MiB. */
export async function admitBrandSocial(bytes: Uint8Array): Promise<SocialAdmission> {
  const base = await validateImage(bytes);
  if (!base.ok) {
    if (base.code === "image_too_large") return { ok: false, note: "social_too_large" };
    if (base.code === "image_dimensions_too_large") {
      return { ok: false, note: "social_invalid_image" };
    }
    return { ok: false, note: "social_not_png" };
  }
  if (base.mime !== "image/png") return { ok: false, note: "social_not_png" };
  const ratio = base.width / base.height;
  if (Math.abs(ratio - SOCIAL_ASPECT) > SOCIAL_ASPECT * SOCIAL_ASPECT_TOLERANCE) {
    return { ok: false, note: "social_bad_ratio" };
  }
  return { ok: true, mime: "image/png", width: base.width, height: base.height };
}

type CurrentBrand = {
  previewAssetId: string | null;
  previewSha256: string | null;
  previewSource: BrandSource | null;
  previewBlobSha: string | null;
  ogAssetId: string | null;
  ogSha256: string | null;
  ogBlobSha: string | null;
};

async function readCurrentBrand(
  db: Db,
  productId: string,
): Promise<CurrentBrand | null> {
  const [row] = await db
    .select({
      previewAssetId: products.previewAssetId,
      previewSha256: products.previewSha256,
      previewSource: products.previewSource,
      previewBlobSha: products.previewBlobSha,
      ogAssetId: products.ogAssetId,
      ogSha256: products.ogSha256,
      ogBlobSha: products.ogBlobSha,
    })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  return row ?? null;
}

function failedIcon(reason: string, note: BrandNote | null = null): IconRefreshOutcome {
  return {
    ok: false,
    source: null,
    sha256: null,
    fetchedAt: null,
    note,
    reason,
    changed: false,
  };
}

function failedSocial(reason: string): SocialRefreshOutcome {
  return { ok: false, sha256: null, fetchedAt: null, reason, changed: false };
}

/** The social-preview fallback failure codes are GitHub's, not the brand slot's. */
const SOCIAL_PREVIEW_REASONS = new Set<SocialPreviewFailure>([
  "ghes",
  "invalid_repo_name",
  "http_error",
  "no_og_image",
  "untrusted_host",
  "too_large",
  "unsupported_image",
  "network",
]);

/** Memoised package-directory lookup: at most one tree walk per refresh. */
type LayoutResolver = () => Promise<BrandLayout>;

function createLayoutResolver(
  client: BrandLayoutReader,
  input: {
    fullName: string;
    installationId: number;
    ref: string | null;
    extensionId: string;
  },
): LayoutResolver {
  let pending: Promise<BrandLayout> | null = null;
  return () => {
    pending ??= locateBrandDir(client, input).catch(() => ({
      dir: "",
      ambiguous: false,
    }));
    return pending;
  };
}

/** Why the brand file was not used, as the dashboard phrases it. */
function iconNoteFor(read: BrandFileResult, ambiguous: boolean): BrandNote | null {
  if (read.ok) return null;
  if (read.reason === "too_large") return "brand_too_large";
  if (read.reason === "not_a_file") return "brand_not_a_file";
  if (read.reason === "github_error") return "brand_read_failed";
  return ambiguous ? "brand_layout_ambiguous" : null;
}

export async function refreshProductBrand(
  db: Db,
  input: {
    productId: string;
    /** Injected in tests; production builds one from the stored GitHub App config. */
    client?: BrandLayoutReader;
    /** Injected in tests; used only by the social-preview fallback. */
    fetchImpl?: typeof fetch;
    now?: () => Date;
  },
): Promise<BrandRefreshResult> {
  const target = await loadRepoTarget(db, input.productId);
  if (!target) {
    return { icon: failedIcon("no_repo"), social: failedSocial("no_repo") };
  }

  let config;
  try {
    config = await requireGithubConfig(db);
  } catch {
    return {
      icon: failedIcon("github_not_configured"),
      social: failedSocial("github_not_configured"),
    };
  }

  const client = input.client ?? new GithubAppClient(config);
  const store = new LocalAssetStore(getConfig().assetDir);
  const current = await readCurrentBrand(db, input.productId);
  const fetchedAt = input.now ? input.now() : new Date();
  const layout = createLayoutResolver(client, {
    fullName: target.fullName,
    installationId: target.installationId,
    ref: target.defaultBranch,
    extensionId: target.extensionId,
  });

  const icon = await resolveIcon({
    db,
    store,
    client,
    layout,
    storeApiBaseUrl: config.apiBaseUrl,
    productId: input.productId,
    target,
    current,
    fetchedAt,
    fetchImpl: input.fetchImpl,
  });

  const social = await resolveSocial({
    db,
    store,
    client,
    layout,
    productId: input.productId,
    target,
    current,
    fetchedAt,
  });

  return { icon, social };
}

async function resolveIcon(input: {
  db: Db;
  store: LocalAssetStore;
  client: BrandLayoutReader;
  layout: LayoutResolver;
  storeApiBaseUrl: string;
  productId: string;
  target: { fullName: string; installationId: number; defaultBranch: string | null };
  current: CurrentBrand | null;
  fetchedAt: Date;
  fetchImpl?: typeof fetch;
}): Promise<IconRefreshOutcome> {
  const { db, store, productId, current, fetchedAt } = input;

  const request = (dir: string) =>
    fetchBrandFile(input.client, {
      fullName: input.target.fullName,
      installationId: input.target.installationId,
      ref: input.target.defaultBranch,
      dir,
      file: BRAND_ICON_FILE,
      maxBytes: BRAND_ICON_MAX_BYTES,
    });

  // The package is usually the repository itself, so the root read is the whole cost in the
  // common case; only a 404 sends us looking for a nested package directory.
  let read = await request("");
  let ambiguous = false;
  if (!read.ok && read.reason === "no_file") {
    const resolved = await input.layout();
    ambiguous = resolved.ambiguous;
    if (resolved.dir !== "") read = await request(resolved.dir);
  }

  if (read.ok) {
    // Unchanged file: refresh the timestamp only. The mark is already correct.
    if (
      current?.previewBlobSha === read.file.sha &&
      current.previewAssetId !== null &&
      current.previewSha256 !== null
    ) {
      await updateProductBrand(db, productId, {
        previewFetchedAt: fetchedAt,
        previewNote: null,
        previewError: null,
      });
      return {
        ok: true,
        source: current.previewSource ?? "brand_icon",
        sha256: current.previewSha256,
        fetchedAt: fetchedAt.toISOString(),
        note: null,
        reason: null,
        changed: false,
      };
    }

    const admitted = await admitBrandIcon(read.file.bytes);
    if (admitted.ok) {
      const stored = await store.put(read.file.bytes);
      const asset = await upsertAsset(db, {
        sha256: stored.sha256,
        mime: admitted.mime,
        width: admitted.width,
        height: admitted.height,
        bytes: read.file.bytes.byteLength,
        storageKey: stored.storageKey,
      });
      await updateProductBrand(db, productId, {
        previewAssetId: asset.id,
        previewSha256: asset.sha256,
        previewSource: "brand_icon",
        previewBlobSha: read.file.sha,
        previewNote: null,
        previewError: null,
        previewFetchedAt: fetchedAt,
      });
      return {
        ok: true,
        source: "brand_icon",
        sha256: asset.sha256,
        fetchedAt: fetchedAt.toISOString(),
        note: null,
        reason: null,
        changed: current?.previewSha256 !== asset.sha256,
      };
    }
    return fallbackToSocialPreview({
      db,
      store,
      storeApiBaseUrl: input.storeApiBaseUrl,
      productId,
      target: input.target,
      current,
      fetchedAt,
      note: admitted.note,
      fetchImpl: input.fetchImpl,
    });
  }

  return fallbackToSocialPreview({
    db,
    store,
    storeApiBaseUrl: input.storeApiBaseUrl,
    productId,
    target: input.target,
    current,
    fetchedAt,
    note: iconNoteFor(read, ambiguous),
    fetchImpl: input.fetchImpl,
  });
}

async function fallbackToSocialPreview(input: {
  db: Db;
  store: LocalAssetStore;
  storeApiBaseUrl: string;
  productId: string;
  target: { fullName: string; installationId: number; defaultBranch: string | null };
  current: CurrentBrand | null;
  fetchedAt: Date;
  note: BrandNote | null;
  fetchImpl?: typeof fetch;
}): Promise<IconRefreshOutcome> {
  const { db, store, productId, current, fetchedAt, note } = input;

  const fallback = await fetchSocialPreview(input.target.fullName, {
    apiBaseUrl: input.storeApiBaseUrl,
    fetchImpl: input.fetchImpl,
  });

  if (!fallback.ok) {
    const reason = SOCIAL_PREVIEW_REASONS.has(fallback.reason)
      ? `social_preview_${fallback.reason}`
      : "social_preview_failed";
    await updateProductBrand(db, productId, {
      previewNote: note,
      previewError: reason,
      previewFetchedAt: fetchedAt,
    });
    return failedIcon(reason, note);
  }

  const stored = await store.put(fallback.preview.bytes);
  const asset = await upsertAsset(db, {
    sha256: stored.sha256,
    mime: fallback.preview.mime,
    width: fallback.preview.width,
    height: fallback.preview.height,
    bytes: fallback.preview.bytes.byteLength,
    storageKey: stored.storageKey,
  });
  await updateProductBrand(db, productId, {
    previewAssetId: asset.id,
    previewSha256: asset.sha256,
    previewSource: "social_preview",
    previewBlobSha: null,
    previewNote: note,
    previewError: null,
    previewFetchedAt: fetchedAt,
  });
  return {
    ok: true,
    source: "social_preview",
    sha256: asset.sha256,
    fetchedAt: fetchedAt.toISOString(),
    note,
    reason: null,
    changed: current?.previewSha256 !== asset.sha256,
  };
}

/** Why the card file was not used; the `github_<status>` tail keeps the HTTP code visible. */
function socialFileReason(read: BrandFileResult): string {
  if (read.ok) return "social_file_present";
  if (read.reason === "no_file") return "social_file_missing";
  if (read.reason === "github_error") {
    return `social_file_github_${read.status ?? "unknown"}`;
  }
  return `social_file_${read.reason}`;
}

async function resolveSocial(input: {
  db: Db;
  store: LocalAssetStore;
  client: BrandLayoutReader;
  layout: LayoutResolver;
  productId: string;
  target: { fullName: string; installationId: number; defaultBranch: string | null };
  current: CurrentBrand | null;
  fetchedAt: Date;
}): Promise<SocialRefreshOutcome> {
  const { db, store, productId, current, fetchedAt } = input;

  const request = (dir: string) =>
    fetchBrandFile(input.client, {
      fullName: input.target.fullName,
      installationId: input.target.installationId,
      ref: input.target.defaultBranch,
      dir,
      file: BRAND_SOCIAL_FILE,
      maxBytes: BRAND_SOCIAL_MAX_BYTES,
    });

  let read = await request("");
  if (!read.ok && read.reason === "no_file") {
    const resolved = await input.layout();
    if (resolved.dir !== "") read = await request(resolved.dir);
  }

  if (!read.ok) {
    const reason = socialFileReason(read);
    await updateProductBrand(db, productId, { ogError: reason, ogFetchedAt: fetchedAt });
    return failedSocial(reason);
  }

  if (
    current?.ogBlobSha === read.file.sha &&
    current.ogAssetId !== null &&
    current.ogSha256 !== null
  ) {
    await updateProductBrand(db, productId, { ogFetchedAt: fetchedAt, ogError: null });
    return {
      ok: true,
      sha256: current.ogSha256,
      fetchedAt: fetchedAt.toISOString(),
      reason: null,
      changed: false,
    };
  }

  const admitted = await admitBrandSocial(read.file.bytes);
  if (!admitted.ok) {
    await updateProductBrand(db, productId, {
      ogError: admitted.note,
      ogFetchedAt: fetchedAt,
    });
    return failedSocial(admitted.note);
  }

  const stored = await store.put(read.file.bytes);
  const asset = await upsertAsset(db, {
    sha256: stored.sha256,
    mime: admitted.mime,
    width: admitted.width,
    height: admitted.height,
    bytes: read.file.bytes.byteLength,
    storageKey: stored.storageKey,
  });
  await updateProductBrand(db, productId, {
    ogAssetId: asset.id,
    ogSha256: asset.sha256,
    ogBlobSha: read.file.sha,
    ogError: null,
    ogFetchedAt: fetchedAt,
  });
  return {
    ok: true,
    sha256: asset.sha256,
    fetchedAt: fetchedAt.toISOString(),
    reason: null,
    changed: current?.ogSha256 !== asset.sha256,
  };
}
