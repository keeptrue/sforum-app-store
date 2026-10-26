import { and, asc, desc, eq, inArray } from "drizzle-orm";

import type { Db } from "@/db/client";
import {
  assets,
  githubRepos,
  moderationEvents,
  productReadmes,
  productTranslations,
  products,
  releaseAssets,
  releaseVersions,
  repoReleases,
  type BrandSource,
} from "@/db/schema";

/**
 * Every SQL statement the dashboard product surface needs. No policy, no sanitizing,
 * no HTTP: callers decide what may happen, this module knows how it is stored.
 */

/** `Db` or an open transaction - store functions work in both contexts. */
export type DbExecutor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type ProductRow = typeof products.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type TranslationRow = typeof productTranslations.$inferSelect;

export type ProductWithPreview = {
  product: ProductRow;
  /** Digest of the stored social preview, or null when the product has no mark. */
  previewSha256: string | null;
};

/** The cached README row; `html` is already through the allow-list. */
export type ReadmeRow = typeof productReadmes.$inferSelect;

export type NewProduct = {
  id: string;
  extensionId: string;
  name: string;
  kind: "plugin" | "theme";
  slug: string;
  ownerAccountId: string;
  category: string | null;
  tags: string[];
  defaultLocale: string;
};

export type TranslationInput = {
  productId: string;
  locale: string;
  name: string;
  summary: string;
};

export type ProductFieldUpdate = {
  name?: string;
  slug?: string;
  category?: string | null;
  tags?: string[];
  defaultLocale?: string;
};

export type NewAsset = {
  sha256: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  storageKey: string;
};

const productPreview = {
  product: products,
  previewSha256: assets.sha256,
};

export async function findProductIdByExtensionId(
  db: DbExecutor,
  extensionId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.extensionId, extensionId))
    .limit(1);
  return row?.id ?? null;
}

export async function findProductIdBySlug(
  db: DbExecutor,
  slug: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.slug, slug))
    .limit(1);
  return row?.id ?? null;
}

export async function findProductByExtensionId(
  db: DbExecutor,
  extensionId: string,
): Promise<ProductRow | null> {
  const [row] = await db
    .select()
    .from(products)
    .where(eq(products.extensionId, extensionId))
    .limit(1);
  return row ?? null;
}

export type ProductRepoBinding = {
  repoId: number;
  boundVia: "installation" | "github_identity";
};

/**
 * Point a product at a repository. Guarded by the owner column so a stale product id from
 * another account cannot move a binding; returns `null` when nothing matched.
 */
export async function setProductRepo(
  db: DbExecutor,
  productId: string,
  accountId: string,
  binding: ProductRepoBinding,
): Promise<ProductRow | null> {
  const [row] = await db
    .update(products)
    .set({
      repoId: binding.repoId,
      repoBoundAt: new Date(),
      repoBoundVia: binding.boundVia,
      updatedAt: new Date(),
    })
    .where(and(eq(products.id, productId), eq(products.ownerAccountId, accountId)))
    .returning();
  return row ?? null;
}

/** Clear the binding. Review compares `repoId`, so this alone makes the next release hold. */
export async function clearProductRepo(
  db: DbExecutor,
  productId: string,
  accountId: string,
): Promise<ProductRow | null> {
  const [row] = await db
    .update(products)
    .set({
      repoId: null,
      repoBoundAt: null,
      repoBoundVia: null,
      updatedAt: new Date(),
    })
    .where(and(eq(products.id, productId), eq(products.ownerAccountId, accountId)))
    .returning();
  return row ?? null;
}

/**
 * Rename a product from its extension manifest.
 *
 * The manifest is the only source of the display name now, so a rename is a data change
 * rather than a copy edit. The default-locale translation row is updated with it because
 * every read surface prefers the translation; a product whose two names disagree would show
 * one name in the catalog and another in review.
 */
export async function renameProduct(
  db: DbExecutor,
  productId: string,
  defaultLocale: string,
  name: string,
): Promise<ProductRow | null> {
  const [row] = await db
    .update(products)
    .set({ name, updatedAt: new Date() })
    .where(eq(products.id, productId))
    .returning();
  if (!row) return null;
  await db
    .update(productTranslations)
    .set({ name, updatedAt: new Date() })
    .where(
      and(
        eq(productTranslations.productId, productId),
        eq(productTranslations.locale, defaultLocale),
      ),
    );
  return row;
}

export async function insertProduct(
  db: DbExecutor,
  values: NewProduct,
): Promise<ProductRow> {
  const [row] = await db.insert(products).values(values).returning();
  if (!row) throw new Error("product insert returned no row");
  return row;
}

export type ProductWithPreviewAndName = ProductWithPreview & {
  /** Default-locale display name; the dashboard list shows the same name as the detail page. */
  translationName: string | null;
};

export async function listProductsByOwner(
  db: DbExecutor,
  accountId: string,
): Promise<ProductWithPreviewAndName[]> {
  return db
    .select({
      ...productPreview,
      translationName: productTranslations.name,
    })
    .from(products)
    .leftJoin(assets, eq(products.previewAssetId, assets.id))
    .leftJoin(
      productTranslations,
      and(
        eq(productTranslations.productId, products.id),
        eq(productTranslations.locale, products.defaultLocale),
      ),
    )
    .where(eq(products.ownerAccountId, accountId))
    .orderBy(desc(products.createdAt), desc(products.id));
}

export async function findOwnedProduct(
  db: DbExecutor,
  productId: string,
  accountId: string,
): Promise<ProductWithPreview | null> {
  const [row] = await db
    .select(productPreview)
    .from(products)
    .leftJoin(assets, eq(products.previewAssetId, assets.id))
    .where(and(eq(products.id, productId), eq(products.ownerAccountId, accountId)))
    .limit(1);
  return row ?? null;
}

export async function updateProductFields(
  db: DbExecutor,
  productId: string,
  accountId: string,
  values: ProductFieldUpdate,
): Promise<ProductRow | null> {
  const [row] = await db
    .update(products)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(products.id, productId), eq(products.ownerAccountId, accountId)))
    .returning();
  return row ?? null;
}

export type ProductReviewUpdate = {
  status?: ProductRow["status"];
  nameAtReview?: string | null;
  repoIdReviewed?: number | null;
  capabilitiesReviewed?: string[];
  publishedAt?: Date | null;
};

/**
 * Un-scoped product write for the moderation flow. Ownership is deliberately not part of
 * the predicate: a moderator acts on someone else's product. Callers must have checked the
 * reviewer role before reaching this.
 */
export async function updateProductReviewState(
  db: DbExecutor,
  productId: string,
  values: ProductReviewUpdate,
): Promise<ProductRow | null> {
  const [row] = await db
    .update(products)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(products.id, productId))
    .returning();
  return row ?? null;
}

/**
 * Everything a brand refresh may write, in one patch shape.
 *
 * Un-scoped by ownership on purpose: the same write is performed by a developer action, by
 * the release/push job and by the daily sweep, and neither job has an account. Every caller
 * checks access before it gets here (route-level ownership, or a job enqueued from one).
 */
export type ProductBrandPatch = {
  previewAssetId?: string | null;
  previewSha256?: string | null;
  previewSource?: BrandSource | null;
  previewBlobSha?: string | null;
  previewNote?: string | null;
  previewError?: string | null;
  previewFetchedAt?: Date | null;
  ogAssetId?: string | null;
  ogSha256?: string | null;
  ogBlobSha?: string | null;
  ogError?: string | null;
  ogFetchedAt?: Date | null;
};

export async function updateProductBrand(
  db: DbExecutor,
  productId: string,
  patch: ProductBrandPatch,
): Promise<void> {
  await db
    .update(products)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(products.id, productId));
}

export async function delistProduct(
  db: DbExecutor,
  productId: string,
  accountId: string,
): Promise<boolean> {
  const rows = await db
    .update(products)
    .set({ status: "delisted", updatedAt: new Date() })
    .where(and(eq(products.id, productId), eq(products.ownerAccountId, accountId)))
    .returning({ id: products.id });
  return rows.length > 0;
}

export async function findTranslation(
  db: DbExecutor,
  productId: string,
  locale: string,
): Promise<TranslationRow | null> {
  const [row] = await db
    .select()
    .from(productTranslations)
    .where(
      and(
        eq(productTranslations.productId, productId),
        eq(productTranslations.locale, locale),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function upsertTranslation(
  db: DbExecutor,
  values: TranslationInput,
): Promise<void> {
  await db
    .insert(productTranslations)
    .values(values)
    .onConflictDoUpdate({
      target: [productTranslations.productId, productTranslations.locale],
      set: {
        name: values.name,
        summary: values.summary,
        updatedAt: new Date(),
      },
    });
}

/** Idempotent by `sha256`: identical bytes reuse the existing row and its id. */
export async function upsertAsset(
  db: DbExecutor,
  values: NewAsset,
): Promise<AssetRow> {
  const [row] = await db
    .insert(assets)
    .values(values)
    .onConflictDoUpdate({
      target: assets.sha256,
      set: {
        mime: values.mime,
        width: values.width,
        height: values.height,
        bytes: values.bytes,
        storageKey: values.storageKey,
      },
    })
    .returning();
  if (!row) throw new Error("asset upsert returned no row");
  return row;
}

export async function findAssetBySha256(
  db: DbExecutor,
  sha256: string,
): Promise<AssetRow | null> {
  const [row] = await db
    .select()
    .from(assets)
    .where(eq(assets.sha256, sha256))
    .limit(1);
  return row ?? null;
}

/** The repository's `owner/name`, for building the README source URL. */
export async function findRepoFullName(
  db: DbExecutor,
  repoId: number,
): Promise<string | null> {
  const [row] = await db
    .select({ fullName: githubRepos.fullName })
    .from(githubRepos)
    .where(eq(githubRepos.repoId, repoId))
    .limit(1);
  return row?.fullName ?? null;
}

export type RepoSyncRow = {
  tag: string;
  state: string;
  lastSyncedAt: Date | null;
  error: string | null;
};

/**
 * The newest release row for a repository, regardless of whether its version was written.
 * `sync_state` is the worker's verdict on the release itself (`syncing`, `synced`,
 * `needs_attention`, `failed`), which is exactly what a developer needs when a tag exists on
 * GitHub but no version appeared in the store.
 */
export async function findLatestRepoSync(
  db: DbExecutor,
  repoId: number,
): Promise<RepoSyncRow | null> {
  const [row] = await db
    .select({
      tag: repoReleases.tag,
      state: repoReleases.syncState,
      lastSyncedAt: repoReleases.lastSyncedAt,
      error: repoReleases.syncError,
    })
    .from(repoReleases)
    .where(eq(repoReleases.repoId, repoId))
    .orderBy(desc(repoReleases.createdAt))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// README cache
// ---------------------------------------------------------------------------

/**
 * The cached README of one product. `repoId` travels with the row so the caller can tell
 * "this describes the current repository" from "this survived a rebind".
 */
export async function getProductReadme(
  db: DbExecutor,
  productId: string,
): Promise<ReadmeRow | null> {
  const [row] = await db
    .select()
    .from(productReadmes)
    .where(eq(productReadmes.productId, productId))
    .limit(1);
  return row ?? null;
}

/** One row per product: a successful fetch replaces the previous text wholesale. */
export async function upsertProductReadme(
  db: DbExecutor,
  values: typeof productReadmes.$inferInsert,
): Promise<ReadmeRow> {
  const [row] = await db
    .insert(productReadmes)
    .values(values)
    .onConflictDoUpdate({
      target: productReadmes.productId,
      set: {
        repoId: values.repoId,
        ref: values.ref ?? "HEAD",
        path: values.path,
        blobSha: values.blobSha,
        markdown: values.markdown,
        html: values.html,
        byteSize: values.byteSize,
        fetchedAt: values.fetchedAt ?? new Date(),
        fetchError: null,
      },
    })
    .returning();
  if (!row) throw new Error("readme upsert returned no row");
  return row;
}

/** Record a failed refresh without discarding the last good copy. */
export async function recordReadmeError(
  db: DbExecutor,
  productId: string,
  message: string,
): Promise<void> {
  await db
    .update(productReadmes)
    .set({ fetchError: message.slice(0, 500) })
    .where(eq(productReadmes.productId, productId));
}

export async function deleteProductReadme(
  db: DbExecutor,
  productId: string,
): Promise<void> {
  await db.delete(productReadmes).where(eq(productReadmes.productId, productId));
}

// ---------------------------------------------------------------------------
// Release versions (read + the one generic state write the dashboard needs)
// ---------------------------------------------------------------------------

export type VersionRowForDashboard = {
  id: string;
  version: string;
  channel: "stable" | "beta";
  state: typeof releaseVersions.$inferSelect.state;
  sforumVersion: string;
  capabilities: string[];
  manifestDescription: string | null;
  manifestUrl: string | null;
  manifestAuthorName: string | null;
  manifestAuthorUrl: string | null;
  publishedAt: Date | null;
  yankedAt: Date | null;
  yankReason: string | null;
  createdAt: Date;
  platforms: { os: string; arch: string }[];
};

export async function listVersionRowsForProduct(
  db: DbExecutor,
  productId: string,
): Promise<VersionRowForDashboard[]> {
  const rows = await db
    .select({
      id: releaseVersions.id,
      version: releaseVersions.version,
      channel: releaseVersions.channel,
      state: releaseVersions.state,
      sforumVersion: releaseVersions.sforumVersionConstraint,
      capabilities: releaseVersions.capabilities,
      manifestDescription: releaseVersions.manifestDescription,
      manifestUrl: releaseVersions.manifestUrl,
      manifestAuthorName: releaseVersions.manifestAuthorName,
      manifestAuthorUrl: releaseVersions.manifestAuthorUrl,
      publishedAt: releaseVersions.publishedAt,
      yankedAt: releaseVersions.yankedAt,
      yankReason: releaseVersions.yankReason,
      createdAt: releaseVersions.createdAt,
      os: releaseAssets.os,
      arch: releaseAssets.arch,
    })
    .from(releaseVersions)
    .leftJoin(releaseAssets, eq(releaseAssets.releaseVersionId, releaseVersions.id))
    .where(eq(releaseVersions.productId, productId))
    .orderBy(asc(releaseVersions.createdAt), asc(releaseAssets.os), asc(releaseAssets.arch));

  const byVersion = new Map<string, VersionRowForDashboard>();
  for (const row of rows) {
    let entry = byVersion.get(row.id);
    if (!entry) {
      entry = {
        id: row.id,
        version: row.version,
        channel: row.channel,
        state: row.state,
        sforumVersion: row.sforumVersion,
        capabilities: row.capabilities,
        manifestDescription: row.manifestDescription,
        manifestUrl: row.manifestUrl,
        manifestAuthorName: row.manifestAuthorName,
        manifestAuthorUrl: row.manifestAuthorUrl,
        publishedAt: row.publishedAt,
        yankedAt: row.yankedAt,
        yankReason: row.yankReason,
        createdAt: row.createdAt,
        platforms: [],
      };
      byVersion.set(row.id, entry);
    }
    if (row.os !== null && row.arch !== null) {
      entry.platforms.push({ os: row.os, arch: row.arch });
    }
  }
  return Array.from(byVersion.values());
}

/** Version + its product, for owner checks that start from a version id. */
export async function findVersionWithProduct(
  db: DbExecutor,
  versionId: string,
): Promise<{ version: typeof releaseVersions.$inferSelect; product: ProductRow } | null> {
  const [row] = await db
    .select({ version: releaseVersions, product: products })
    .from(releaseVersions)
    .innerJoin(products, eq(products.id, releaseVersions.productId))
    .where(eq(releaseVersions.id, versionId))
    .limit(1);
  return row ?? null;
}

export async function updateReleaseVersionState(
  db: DbExecutor,
  versionId: string,
  patch: {
    state: typeof releaseVersions.$inferSelect.state;
    publishedAt?: Date | null;
    yankedAt?: Date | null;
    yankReason?: string | null;
  },
): Promise<void> {
  await db
    .update(releaseVersions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(releaseVersions.id, versionId));
}

/**
 * Latest rejection reason per product, for the owner-facing surfaces. One query for the whole
 * page instead of N: the dashboard list must explain a rejected row without an extra round trip.
 */
export async function listLatestRejectionReasons(
  db: DbExecutor,
  productIds: string[],
): Promise<Map<string, string | null>> {
  if (productIds.length === 0) return new Map();
  const rows = await db
    .select({
      productId: moderationEvents.productId,
      reason: moderationEvents.reason,
      createdAt: moderationEvents.createdAt,
    })
    .from(moderationEvents)
    .where(
      and(
        inArray(moderationEvents.productId, productIds),
        eq(moderationEvents.action, "rejected"),
      ),
    )
    .orderBy(desc(moderationEvents.createdAt));

  const reasons = new Map<string, string | null>();
  for (const row of rows) {
    if (row.productId === null || reasons.has(row.productId)) continue;
    reasons.set(row.productId, row.reason);
  }
  return reasons;
}
