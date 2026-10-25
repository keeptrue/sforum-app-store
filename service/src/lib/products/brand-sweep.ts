import { and, eq, isNull, lt, or, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { githubRepos, products } from "@/db/schema";
import { refreshProductBrand } from "./brand";

/**
 * The daily backstop for everything the event-driven triggers cannot see.
 *
 * Releases and pushes cover "the developer changed the repository". They do not cover a
 * database restored from backup, a webhook delivery GitHub gave up on, an App whose `push`
 * subscription was added *after* the product existed, or a brand file that appeared on a
 * branch the push filter treated as unrelated. One conditional read per product per day is
 * cheap (the blob sha usually matches, so nothing is downloaded) and turns all of those into
 * a bounded, self-healing delay instead of a permanent wrong picture.
 *
 * A connected upstream is part of the predicate: refreshing a repository whose installation
 * was deleted only produces error rows.
 */

export const BRAND_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;
export const BRAND_SWEEP_BATCH = 200;
export const BRAND_SWEEP_GAP_MS = 250;

export type BrandSweepResult = {
  scanned: number;
  refreshed: number;
  failed: number;
};

export async function sweepStaleBrands(
  db: Db,
  options: {
    limit?: number;
    gapMs?: number;
    now?: Date;
    /** Injected in tests; production uses `refreshProductBrand` (network included). */
    refresh?: (productId: string) => Promise<unknown>;
  } = {},
): Promise<BrandSweepResult> {
  const limit = options.limit ?? BRAND_SWEEP_BATCH;
  const gapMs = options.gapMs ?? BRAND_SWEEP_GAP_MS;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - BRAND_SWEEP_AGE_MS);
  const refresh =
    options.refresh ?? ((productId: string) => refreshProductBrand(db, { productId }));

  const rows = await db
    .select({ id: products.id })
    .from(products)
    .innerJoin(githubRepos, eq(githubRepos.repoId, products.repoId))
    .where(
      and(
        eq(githubRepos.upstreamState, "connected"),
        or(
          isNull(products.previewFetchedAt),
          lt(products.previewFetchedAt, cutoff),
          isNull(products.ogFetchedAt),
          lt(products.ogFetchedAt, cutoff),
        ),
      ),
    )
    // Oldest first, missing timestamps before everything: a fresh deployment drains its
    // backlog in order instead of re-picking the same sample.
    .orderBy(sql`${products.previewFetchedAt} asc nulls first`, products.id)
    .limit(limit);

  let refreshed = 0;
  let failed = 0;
  for (const [index, row] of rows.entries()) {
    try {
      await refresh(row.id);
      refreshed += 1;
    } catch {
      failed += 1;
    }
    if (gapMs > 0 && index < rows.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
  }

  return { scanned: rows.length, refreshed, failed };
}
