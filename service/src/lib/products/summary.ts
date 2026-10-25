import { asc, eq, sql } from "drizzle-orm";

import {
  latestVersion,
  type VersionSummary,
} from "./version-summary";
import type { Db } from "@/db/client";
import { products, releaseVersions } from "@/db/schema";

import type { DashboardVersion } from "./types";

/**
 * "Latest version" and "version count" for every product of one owner, in one statement.
 *
 * `latestVersion()` reads exactly three fields of a version row - `version`, `state` and
 * `createdAt` - so the aggregate carries those three plus
 * `count(*) over (partition by product_id)`. No ordering rule is restated here: semver
 * maxima stay in TypeScript (`node-semver`), which SQL cannot express (text ordering puts
 * `1.10.0` before `1.9.0`).
 */

export type ProductVersionSummary = {
  versionCount: number;
  latest: VersionSummary | null;
};

/** Products with no version rows are absent from the aggregate; this is their summary. */
export const EMPTY_VERSION_SUMMARY: ProductVersionSummary = Object.freeze({
  versionCount: 0,
  latest: null,
});

/** The only `DashboardVersion` fields the display rule reads. */
type LatestVersionFacts = Pick<DashboardVersion, "version" | "state" | "createdAt">;

/**
 * `latestVersion()` is the list's single definition of "latest" and lives in the component
 * module, outside this change. The cast narrows the accepted *field set* (the aggregate
 * carries no assets or capability columns), never the values: the batch read feeds the real
 * function, so multi-channel and no-published-version behaviour cannot drift from the list.
 */
const pickLatest = latestVersion as (
  versions: LatestVersionFacts[],
) => VersionSummary | null;

type VersionBucket = {
  versionCount: number;
  facts: LatestVersionFacts[];
};

/**
 * One `SELECT` for the whole page. Products without a version row produce no row and are
 * therefore absent from the map - callers fall back to `EMPTY_VERSION_SUMMARY`. Only rows
 * whose product is owned by `accountId` are read.
 */
export async function listProductVersionSummaries(
  db: Db,
  accountId: string,
): Promise<Map<string, ProductVersionSummary>> {
  const rows = await db
    .select({
      productId: releaseVersions.productId,
      version: releaseVersions.version,
      state: releaseVersions.state,
      createdAt: releaseVersions.createdAt,
      versionCount:
        sql<number>`count(*) over (partition by ${releaseVersions.productId})`.mapWith(
          Number,
        ),
    })
    .from(products)
    .innerJoin(releaseVersions, eq(releaseVersions.productId, products.id))
    .where(eq(products.ownerAccountId, accountId))
    // Oldest first, mirroring the detail read's order: the newest-first `createdAt`
    // fallback inside `latestVersion()` then keeps the same tie-breaking order.
    .orderBy(asc(releaseVersions.createdAt), asc(releaseVersions.id));

  const buckets = new Map<string, VersionBucket>();
  for (const row of rows) {
    let bucket = buckets.get(row.productId);
    if (!bucket) {
      bucket = { versionCount: row.versionCount, facts: [] };
      buckets.set(row.productId, bucket);
    }
    bucket.facts.push({
      version: row.version,
      state: row.state,
      createdAt: row.createdAt.toISOString(),
    });
  }

  const summaries = new Map<string, ProductVersionSummary>();
  for (const [productId, bucket] of buckets) {
    summaries.set(productId, {
      versionCount: bucket.versionCount,
      latest: pickLatest(bucket.facts),
    });
  }
  return summaries;
}
