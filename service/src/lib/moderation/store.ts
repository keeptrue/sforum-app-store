import { and, eq, inArray, sql } from "drizzle-orm";

import { products, releaseVersions } from "@/db/schema";
import type { DbExecutor } from "@/lib/products/store";

/**
 * Every SQL statement a moderation decision needs. Reads live in `queue.ts`; this module
 * is the write path, so each function is a conditional transition: the `WHERE` clause
 * carries the source state and `null` means "the row was not in that state, somebody else
 * got there first". Nothing here decides policy or shapes HTTP.
 */

export type ProductRow = typeof products.$inferSelect;

/** What a version contributes to the approval snapshot. */
export type VersionContribution = {
  id: string;
  version: string;
  capabilities: string[];
};

/** Versions a product approval publishes; a release approval publishes exactly one. */
const REVIEWABLE_VERSION_STATES = ["candidate", "pending_review"] as const;

export async function findProductRow(
  db: DbExecutor,
  productId: string,
): Promise<ProductRow | null> {
  const [row] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  return row ?? null;
}

/**
 * `pending_review -> published`. `published_at` keeps its first value: a product that was
 * delisted and re-approved must not look newly published (plan §7.4 item 8).
 */
export async function publishPendingProduct(
  db: DbExecutor,
  productId: string,
  now: Date,
): Promise<ProductRow | null> {
  const [row] = await db
    .update(products)
    .set({
      status: "published",
      publishedAt: sql`coalesce(${products.publishedAt}, now())`,
      updatedAt: now,
    })
    .where(and(eq(products.id, productId), eq(products.status, "pending_review")))
    .returning();
  return row ?? null;
}

/** `pending_review -> rejected`. */
export async function rejectPendingProduct(
  db: DbExecutor,
  productId: string,
  now: Date,
): Promise<ProductRow | null> {
  const [row] = await db
    .update(products)
    .set({ status: "rejected", updatedAt: now })
    .where(and(eq(products.id, productId), eq(products.status, "pending_review")))
    .returning();
  return row ?? null;
}

/** `published -> delisted`. Versions keep their state; only visibility changed. */
export async function delistPublishedProduct(
  db: DbExecutor,
  productId: string,
  now: Date,
): Promise<ProductRow | null> {
  const [row] = await db
    .update(products)
    .set({ status: "delisted", updatedAt: now })
    .where(and(eq(products.id, productId), eq(products.status, "published")))
    .returning();
  return row ?? null;
}

/**
 * Publish every version that was waiting for this product's first approval. Only the
 * state (and the publication clock) changes — a version's bytes, digest and capability
 * list are immutable once synced (plan §7.4 item 14).
 */
export async function publishReviewableVersions(
  db: DbExecutor,
  productId: string,
  now: Date,
): Promise<VersionContribution[]> {
  return db
    .update(releaseVersions)
    .set({ state: "published", publishedAt: sql`now()`, updatedAt: now })
    .where(
      and(
        eq(releaseVersions.productId, productId),
        inArray(releaseVersions.state, [...REVIEWABLE_VERSION_STATES]),
      ),
    )
    .returning({
      id: releaseVersions.id,
      version: releaseVersions.version,
      capabilities: releaseVersions.capabilities,
    });
}

/** `pending_review -> published` for one version (the re-review bucket). */
export async function publishPendingVersion(
  db: DbExecutor,
  versionId: string,
  now: Date,
): Promise<VersionContribution | null> {
  const [row] = await db
    .update(releaseVersions)
    .set({ state: "published", publishedAt: sql`now()`, updatedAt: now })
    .where(
      and(
        eq(releaseVersions.id, versionId),
        eq(releaseVersions.state, "pending_review"),
      ),
    )
    .returning({
      id: releaseVersions.id,
      version: releaseVersions.version,
      capabilities: releaseVersions.capabilities,
    });
  return row ?? null;
}

/** `pending_review -> rejected` for one version. */
export async function rejectPendingVersion(
  db: DbExecutor,
  versionId: string,
  now: Date,
): Promise<VersionContribution | null> {
  const [row] = await db
    .update(releaseVersions)
    .set({ state: "rejected", updatedAt: now })
    .where(
      and(
        eq(releaseVersions.id, versionId),
        eq(releaseVersions.state, "pending_review"),
      ),
    )
    .returning({
      id: releaseVersions.id,
      version: releaseVersions.version,
      capabilities: releaseVersions.capabilities,
    });
  return row ?? null;
}

export type ReviewSnapshot = {
  nameAtReview: string;
  repoIdReviewed: number | null;
  capabilitiesReviewed: string[];
};

/**
 * Replace what a moderator has actually seen. Written in the same transaction as the
 * approval, so a release synced later can compare against it (plan §7.4 item 12).
 */
export async function setReviewSnapshot(
  db: DbExecutor,
  productId: string,
  snapshot: ReviewSnapshot,
  now: Date,
): Promise<void> {
  await db
    .update(products)
    .set({
      nameAtReview: snapshot.nameAtReview,
      repoIdReviewed: snapshot.repoIdReviewed,
      capabilitiesReviewed: snapshot.capabilitiesReviewed,
      updatedAt: now,
    })
    .where(eq(products.id, productId));
}
