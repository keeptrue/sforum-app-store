import { and, eq } from "drizzle-orm";
import semver from "semver";

import type { Db } from "@/db/client";
import { products, releaseVersions } from "@/db/schema";

export type LatestVersions = {
  stable: string | null;
  beta: string | null;
};

function maxVersion(versions: string[]): string | null {
  let best: string | null = null;
  for (const version of versions) {
    if (!semver.valid(version)) continue;
    if (best === null || semver.gt(version, best)) best = version;
  }
  return best;
}

/**
 * Recompute the materialized semver maxima after a version changes state.
 *
 * `latest_*_version_id` is what the catalog sorts and labels with; it is deliberately
 * NOT "most recently published" (Q4: ordering is semver, not time). Versions whose
 * manifest version is not strict semver never become the latest.
 */
export async function recomputeProductLatestVersions(
  db: Db,
  productId: string,
): Promise<LatestVersions> {
  const rows = await db
    .select({
      id: releaseVersions.id,
      version: releaseVersions.version,
      channel: releaseVersions.channel,
    })
    .from(releaseVersions)
    .where(
      and(
        eq(releaseVersions.productId, productId),
        eq(releaseVersions.state, "published"),
      ),
    );

  const byChannel = (channel: "stable" | "beta") =>
    rows.filter((row) => row.channel === channel);

  const pick = (channel: "stable" | "beta") => {
    const candidates = byChannel(channel);
    const best = maxVersion(candidates.map((row) => row.version));
    if (best === null) return { version: null, id: null };
    const row = candidates.find((item) => item.version === best);
    return { version: best, id: row?.id ?? null };
  };

  const stable = pick("stable");
  const beta = pick("beta");

  await db
    .update(products)
    .set({
      latestStableVersionId: stable.id,
      latestBetaVersionId: beta.id,
      updatedAt: new Date(),
    })
    .where(eq(products.id, productId));

  return { stable: stable.version, beta: beta.version };
}
