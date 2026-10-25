import type { Db } from "@/db/client";
import { refreshProductBrand } from "./brand";

/**
 * When a brand refresh is allowed to start without anyone waiting on it.
 *
 * A push event, a release and a dashboard click can all land within seconds of each other
 * for the same product. The blob-sha comparison inside the refresh already makes the second
 * call cheap, but it is still an installation-token request, so the trigger points share one
 * per-process throttle.
 *
 * Per process and per product, like the README cache: several replicas each keep their own
 * map, so the worst case is one extra refresh per replica per minute.
 */

export const BRAND_RETRY_MS = 60 * 1000;

/** Bound on the throttle map; a busy store should not grow it without limit. */
const MAX_TRACKED = 1000;

const lastAttempt = new Map<string, number>();

/**
 * Start a refresh without awaiting it. Never throws: the refresh records its own failures on
 * the product row and leaves the previous mark in place.
 *
 * Returns false when the throttle swallowed the call.
 */
export function scheduleBrandRefresh(
  db: Db,
  productId: string,
  now = Date.now(),
): boolean {
  const previous = lastAttempt.get(productId);
  if (previous !== undefined && now - previous < BRAND_RETRY_MS) return false;
  if (lastAttempt.size >= MAX_TRACKED) lastAttempt.clear();
  lastAttempt.set(productId, now);
  void refreshProductBrand(db, { productId }).catch(() => undefined);
  return true;
}

/** Test hook: the throttle is process state, so a test must be able to start clean. */
export function resetBrandRefreshThrottle(): void {
  lastAttempt.clear();
}
