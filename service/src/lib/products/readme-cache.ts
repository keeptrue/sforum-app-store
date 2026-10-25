import { eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import { products } from "@/db/schema";
import { refreshProductReadme } from "@/lib/github/readme";

/**
 * When a cached README is refreshed.
 *
 * The public page never waits on GitHub: it renders whatever `product_readmes` holds and
 * schedules a refresh *after* the response when the copy is older than the TTL. That keeps
 * the "introduction follows the repository" promise without putting an outbound request, an
 * installation token, or a multi-hundred-millisecond latency on a visitor-triggered path.
 *
 * Throttling is per process and per product. Several replicas each keep their own map, so
 * the worst case is one refresh per replica per minute — acceptable for a read that is
 * already cached for fifteen.
 */

/** How long a cached README is considered current. */
export const README_TTL_MS = 15 * 60 * 1000;

/** Minimum gap between two refresh attempts for the same product in this process. */
const RETRY_MS = 60 * 1000;

/** Bound on the throttle map; a busy store should not grow it without limit. */
const MAX_TRACKED = 1000;

const lastAttempt = new Map<string, number>();

export type ReadmeFreshness = { fetchedAt: string | Date } | null;

/** A missing row is stale by definition: there is nothing to show until a fetch lands. */
export function isReadmeStale(readme: ReadmeFreshness, now = Date.now()): boolean {
  if (readme === null) return true;
  const fetched = readme.fetchedAt instanceof Date
    ? readme.fetchedAt.getTime()
    : Date.parse(readme.fetchedAt);
  if (!Number.isFinite(fetched)) return true;
  return now - fetched >= README_TTL_MS;
}

function claimAttempt(productId: string, now: number): boolean {
  const previous = lastAttempt.get(productId);
  if (previous !== undefined && now - previous < RETRY_MS) return false;
  if (lastAttempt.size >= MAX_TRACKED) lastAttempt.clear();
  lastAttempt.set(productId, now);
  return true;
}

/**
 * Start a refresh without awaiting it. Never throws: a failed refresh leaves the previous
 * text in place and writes `fetch_error` on the row for the dashboard to show.
 */
export function scheduleReadmeRefresh(db: Db, productId: string): void {
  if (!claimAttempt(productId, Date.now())) return;
  void refreshProductReadme(db, { productId }).catch(() => undefined);
}

/**
 * Same, resolved from a slug. The public detail route has the slug (the contract's only
 * identifier) and needs the product id; that is one extra indexed read, only on the requests
 * where the cached copy is stale.
 */
export async function scheduleReadmeRefreshBySlug(
  db: Db,
  slug: string,
): Promise<void> {
  const [row] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.slug, slug))
    .limit(1);
  if (!row) return;
  scheduleReadmeRefresh(db, row.id);
}
