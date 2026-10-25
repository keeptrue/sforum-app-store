import { and, desc, eq, inArray, or } from "drizzle-orm";
import semver from "semver";

import type { Db } from "@/db/client";
import {
  accounts,
  assets,
  githubRepos,
  moderationEvents,
  productReadmes,
  productTranslations,
  products,
  releaseVersions,
} from "@/db/schema";
import type { DbExecutor, ProductRow } from "@/lib/products/store";
import { listVersionRowsForProduct } from "@/lib/products/store";
import type { DashboardProduct, DashboardVersion } from "@/lib/products/types";
import { assetUrl } from "@/lib/storage/urls";
import type { ModerationReadme } from "./types";
import type {
  ModerationEvent,
  ModerationProductDetail,
  ModerationQueue,
  ModerationQueueProduct,
  ModerationQueueVersion,
} from "./types";

/**
 * Read model for `/api/moderation/**`. Every query a moderator surface needs lives here;
 * the decisions themselves (and their writes) live in `service.ts`.
 *
 * Two buckets, because the plan splits lifecycle from release state (§5.3 Q3):
 * a product waiting for its first approval, and a single version held back because it
 * introduces a capability nobody approved, or because the product changed since approval.
 */

/** States that a product approval would publish (plan §7.4 item 8). */
const REVIEWABLE_VERSION_STATES = ["candidate", "pending_review"] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * The name a user sees: the default-locale translation when it has one, the product
 * column otherwise. The review snapshot stores exactly this value, so a comparison
 * against `name_at_review` is a comparison of the same thing.
 */
export function displayNameOf(input: {
  name: string;
  translationName: string | null;
}): string {
  const translated = input.translationName?.trim();
  return translated && translated.length > 0 ? translated : input.name;
}

/** Distinct capability keys, first-seen order, ignoring the ones already approved. */
function newCapabilities(
  capabilities: string[],
  reviewed: string[],
): string[] {
  const approved = new Set(reviewed);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const capability of capabilities) {
    if (approved.has(capability) || seen.has(capability)) continue;
    seen.add(capability);
    out.push(capability);
  }
  return out;
}

function unionCapabilities(lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const capability of list) {
      if (seen.has(capability)) continue;
      seen.add(capability);
      out.push(capability);
    }
  }
  return out;
}

/** Semver maximum; a manifest version that is not strict semver never wins. */
function latestVersionOf(versions: { version: string }[]): string | null {
  let best: string | null = null;
  for (const entry of versions) {
    if (!semver.valid(entry.version)) continue;
    if (best === null || semver.gt(entry.version, best)) best = entry.version;
  }
  return best;
}

function toDashboardProduct(
  product: ProductRow,
  previewSha256: string | null,
): DashboardProduct {
  return {
    id: product.id,
    slug: product.slug,
    extensionId: product.extensionId,
    name: product.name,
    kind: product.kind,
    status: product.status,
    category: product.category,
    tags: product.tags,
    previewUrl: previewSha256 ? assetUrl(previewSha256) : null,
    repoId: product.repoId,
    // The moderation surfaces never show the developer-facing rejection hint; the queue and
    // the detail carry the full event timeline instead.
    reviewReason: null,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

function toDashboardVersion(version: {
  id: string;
  version: string;
  channel: "stable" | "beta";
  state: DashboardVersion["state"];
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
}): DashboardVersion {
  return {
    id: version.id,
    version: version.version,
    channel: version.channel,
    state: version.state,
    sforumVersion: version.sforumVersion,
    capabilities: version.capabilities,
    manifestDescription: version.manifestDescription,
    manifestUrl: version.manifestUrl,
    manifestAuthorName: version.manifestAuthorName,
    manifestAuthorUrl: version.manifestAuthorUrl,
    publishedAt: version.publishedAt?.toISOString() ?? null,
    yankedAt: version.yankedAt?.toISOString() ?? null,
    yankReason: version.yankReason,
    createdAt: version.createdAt.toISOString(),
    assetPlatforms: version.platforms,
  };
}

function actorNameOf(row: {
  displayName: string | null;
  username: string | null;
}): string | null {
  return row.displayName ?? row.username ?? null;
}

/** Newest activity for a product and every version it owns, for the detail timeline. */
async function loadTimeline(
  db: DbExecutor,
  productId: string,
  versionIds: string[],
): Promise<ModerationEvent[]> {
  const subject = versionIds.length
    ? or(
        eq(moderationEvents.productId, productId),
        inArray(moderationEvents.releaseVersionId, versionIds),
      )
    : eq(moderationEvents.productId, productId);

  const rows = await db
    .select({
      event: moderationEvents,
      displayName: accounts.displayName,
      username: accounts.username,
    })
    .from(moderationEvents)
    .leftJoin(accounts, eq(accounts.id, moderationEvents.actorAccountId))
    .where(subject)
    .orderBy(desc(moderationEvents.createdAt), desc(moderationEvents.id));

  return rows.map((row) => ({
    id: row.event.id,
    action: row.event.action,
    fromState: row.event.fromState,
    toState: row.event.toState,
    reason: row.event.reason,
    // No actor row means the sync worker did it.
    actor: actorNameOf(row),
    createdAt: row.event.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

async function loadPendingProducts(
  db: DbExecutor,
): Promise<ModerationQueueProduct[]> {
  const rows = await db
    .select({
      id: products.id,
      slug: products.slug,
      extensionId: products.extensionId,
      name: products.name,
      kind: products.kind,
      updatedAt: products.updatedAt,
      translationName: productTranslations.name,
    })
    .from(products)
    .leftJoin(
      productTranslations,
      and(
        eq(productTranslations.productId, products.id),
        eq(productTranslations.locale, products.defaultLocale),
      ),
    )
    .where(eq(products.status, "pending_review"))
    .orderBy(products.updatedAt);

  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  // Everything a single approval would publish, with the capability set it carries.
  const versionRows = await db
    .select({
      productId: releaseVersions.productId,
      version: releaseVersions.version,
      capabilities: releaseVersions.capabilities,
    })
    .from(releaseVersions)
    .where(
      and(
        inArray(releaseVersions.productId, ids),
        inArray(releaseVersions.state, [...REVIEWABLE_VERSION_STATES]),
      ),
    );

  // Latest real submission per product. Submissions are rare, so filtering in JS after
  // one ordered query beats N round trips.
  const submissionRows = await db
    .select({
      productId: moderationEvents.productId,
      createdAt: moderationEvents.createdAt,
      displayName: accounts.displayName,
      username: accounts.username,
    })
    .from(moderationEvents)
    .leftJoin(accounts, eq(accounts.id, moderationEvents.actorAccountId))
    .where(
      and(
        inArray(moderationEvents.productId, ids),
        eq(moderationEvents.action, "submitted"),
      ),
    )
    .orderBy(desc(moderationEvents.createdAt), desc(moderationEvents.id));

  const versionsByProduct = new Map<
    string,
    { version: string; capabilities: string[] }[]
  >();
  for (const row of versionRows) {
    const list = versionsByProduct.get(row.productId) ?? [];
    list.push({ version: row.version, capabilities: row.capabilities });
    versionsByProduct.set(row.productId, list);
  }

  const submissionByProduct = new Map<string, { at: Date; actor: string | null }>();
  for (const row of submissionRows) {
    if (!row.productId || submissionByProduct.has(row.productId)) continue;
    submissionByProduct.set(row.productId, {
      at: row.createdAt,
      actor: actorNameOf(row),
    });
  }

  const items: ModerationQueueProduct[] = rows.map((row) => {
    const versions = versionsByProduct.get(row.id) ?? [];
    const submission = submissionByProduct.get(row.id);
    return {
      productId: row.id,
      slug: row.slug,
      extensionId: row.extensionId,
      name: displayNameOf({ name: row.name, translationName: row.translationName }),
      kind: row.kind,
      // Older submissions first: the queue is served in waiting order.
      submittedAt: (submission?.at ?? row.updatedAt).toISOString(),
      submittedBy: submission?.actor ?? null,
      versionCount: versions.length,
      latestVersion: latestVersionOf(versions),
      capabilities: unionCapabilities(
        versions.map((version) => version.capabilities),
      ).sort(),
    };
  });

  return items.sort((left, right) => {
    const delta = left.submittedAt.localeCompare(right.submittedAt);
    return delta !== 0 ? delta : left.productId.localeCompare(right.productId);
  });
}

async function loadPendingVersions(
  db: DbExecutor,
): Promise<ModerationQueueVersion[]> {
  const rows = await db
    .select({
      versionId: releaseVersions.id,
      productId: products.id,
      slug: products.slug,
      extensionId: products.extensionId,
      version: releaseVersions.version,
      channel: releaseVersions.channel,
      createdAt: releaseVersions.createdAt,
      sforumVersion: releaseVersions.sforumVersionConstraint,
      capabilities: releaseVersions.capabilities,
      productName: products.name,
      nameAtReview: products.nameAtReview,
      capabilitiesReviewed: products.capabilitiesReviewed,
      translationName: productTranslations.name,
    })
    .from(releaseVersions)
    .innerJoin(products, eq(products.id, releaseVersions.productId))
    .leftJoin(
      productTranslations,
      and(
        eq(productTranslations.productId, products.id),
        eq(productTranslations.locale, products.defaultLocale),
      ),
    )
    // Only a published product has something to re-review: the first release of an
    // unpublished product is covered by the product row above.
    .where(
      and(
        eq(releaseVersions.state, "pending_review"),
        eq(products.status, "published"),
      ),
    )
    .orderBy(releaseVersions.createdAt, releaseVersions.id);

  return rows.map((row) => {
    const productName = displayNameOf({
      name: row.productName,
      translationName: row.translationName,
    });
    return {
      versionId: row.versionId,
      productId: row.productId,
      slug: row.slug,
      extensionId: row.extensionId,
      productName,
      version: row.version,
      channel: row.channel,
      createdAt: row.createdAt.toISOString(),
      sforumVersion: row.sforumVersion,
      capabilities: row.capabilities,
      capabilitiesNew: newCapabilities(row.capabilities, row.capabilitiesReviewed),
      productRenamed: row.nameAtReview !== null && productName !== row.nameAtReview,
    };
  });
}

export async function loadModerationQueue(db: Db): Promise<ModerationQueue> {
  const [pendingProducts, pendingVersions] = await Promise.all([
    loadPendingProducts(db),
    loadPendingVersions(db),
  ]);
  return { products: pendingProducts, versions: pendingVersions };
}

// ---------------------------------------------------------------------------
// Product detail
// ---------------------------------------------------------------------------

/**
 * The README a moderator is looking at, with the provenance that matters for review.
 *
 * This is *not* a snapshot: the row is whatever the last refresh fetched. The digest and
 * timestamp are shown so a reviewer can tell "approved this text" from "approved the summary
 * and the manifest"; a change after approval lands in the audit trail as
 * `product.readme_changed`.
 */
function moderationReadme(row: {
  product: { repoId: number | null };
  repoFullName: string | null;
  readmeRepoId: number | null;
  readmePath: string | null;
  readmeBlobSha: string | null;
  readmeHtml: string | null;
  readmeByteSize: number | null;
  readmeFetchedAt: Date | null;
}): ModerationReadme | null {
  if (
    row.readmeHtml === null ||
    row.readmePath === null ||
    row.readmeFetchedAt === null ||
    row.readmeRepoId === null ||
    row.product.repoId === null ||
    row.readmeRepoId !== row.product.repoId
  ) {
    return null;
  }
  return {
    path: row.readmePath,
    html: row.readmeHtml,
    blobSha: row.readmeBlobSha,
    fetchedAt: row.readmeFetchedAt.toISOString(),
    byteSize: row.readmeByteSize,
    sourceUrl:
      row.repoFullName === null
        ? null
        : `https://github.com/${row.repoFullName}/blob/HEAD/${row.readmePath}`,
  };
}

export async function loadModerationProductDetail(
  db: Db,
  productId: string,
): Promise<ModerationProductDetail | null> {
  if (!isUuid(productId)) return null;

  const [row] = await db
    .select({
      product: products,
      previewSha256: assets.sha256,
      translationName: productTranslations.name,
      translationSummary: productTranslations.summary,
      repoFullName: githubRepos.fullName,
      readmeRepoId: productReadmes.repoId,
      readmePath: productReadmes.path,
      readmeBlobSha: productReadmes.blobSha,
      readmeHtml: productReadmes.html,
      readmeByteSize: productReadmes.byteSize,
      readmeFetchedAt: productReadmes.fetchedAt,
    })
    .from(products)
    .leftJoin(assets, eq(products.previewAssetId, assets.id))
    .leftJoin(productReadmes, eq(productReadmes.productId, products.id))
    .leftJoin(
      productTranslations,
      and(
        eq(productTranslations.productId, products.id),
        eq(productTranslations.locale, products.defaultLocale),
      ),
    )
    .leftJoin(githubRepos, eq(githubRepos.repoId, products.repoId))
    .where(eq(products.id, productId))
    .limit(1);
  if (!row) return null;

  const versions = await listVersionRowsForProduct(db, productId);

  const reviewable = versions.filter((version) =>
    (REVIEWABLE_VERSION_STATES as readonly string[]).includes(version.state),
  );
  const events = await loadTimeline(
    db,
    productId,
    versions.map((version) => version.id),
  );

  const submission = await db
    .select({
      createdAt: moderationEvents.createdAt,
      displayName: accounts.displayName,
      username: accounts.username,
    })
    .from(moderationEvents)
    .leftJoin(accounts, eq(accounts.id, moderationEvents.actorAccountId))
    .where(
      and(
        eq(moderationEvents.productId, productId),
        eq(moderationEvents.action, "submitted"),
      ),
    )
    .orderBy(desc(moderationEvents.createdAt), desc(moderationEvents.id))
    .limit(1);

  const name = displayNameOf({
    name: row.product.name,
    translationName: row.translationName,
  });
  const submitted = submission[0];

  return {
    product: { ...toDashboardProduct(row.product, row.previewSha256), name },
    summary: row.translationSummary ?? "",
    readme: moderationReadme(row),
    versions: versions.map(toDashboardVersion),
    repoFullName: row.repoFullName,
    submittedBy: submitted ? actorNameOf(submitted) : null,
    // Straight from the trail: a product that was never submitted keeps null, rather
    // than pretending its last edit was a submission.
    submittedAt: submitted ? submitted.createdAt.toISOString() : null,
    publishedAt: row.product.publishedAt?.toISOString() ?? null,
    nameAtReview: row.product.nameAtReview,
    capabilitiesReviewed: row.product.capabilitiesReviewed,
    capabilitiesNew: newCapabilities(
      unionCapabilities(reviewable.map((version) => version.capabilities)),
      row.product.capabilitiesReviewed,
    ),
    productRenamed:
      row.product.nameAtReview !== null && name !== row.product.nameAtReview,
    events,
  };
}

// ---------------------------------------------------------------------------
// Small reads the decision service needs for its responses and snapshots
// ---------------------------------------------------------------------------

/** The product as the dashboard DTO sees it (raw `products.name`, not the translation). */
export async function loadDashboardProduct(
  db: DbExecutor,
  productId: string,
): Promise<DashboardProduct | null> {
  if (!isUuid(productId)) return null;
  const [row] = await db
    .select({ product: products, previewSha256: assets.sha256 })
    .from(products)
    .leftJoin(assets, eq(assets.id, products.previewAssetId))
    .where(eq(products.id, productId))
    .limit(1);
  return row ? toDashboardProduct(row.product, row.previewSha256) : null;
}

/** The display name an approval records into `name_at_review`. */
export async function loadDisplayName(
  db: DbExecutor,
  product: { id: string; name: string; defaultLocale: string },
): Promise<string> {
  const [row] = await db
    .select({ name: productTranslations.name })
    .from(productTranslations)
    .where(
      and(
        eq(productTranslations.productId, product.id),
        eq(productTranslations.locale, product.defaultLocale),
      ),
    )
    .limit(1);
  return displayNameOf({ name: product.name, translationName: row?.name ?? null });
}
