import { lt, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { rateLimits } from "@/db/schema";
import type { RateLimitRule } from "./rules";

/**
 * Fixed-window counter in Postgres.
 *
 * Why Postgres and not memory: the store may run several replicas, and a per-process
 * bucket would multiply every limit by the replica count. Why not Redis: the stack already
 * has Postgres and the traffic here is login/submit/download, not a high-QPS edge; one
 * upsert per checked request is cheap and needs no new dependency.
 */

export type RateLimitDecision =
  | { ok: true; remaining: number | null; degraded: boolean }
  | { ok: false; retryAfterSeconds: number };

export type ConsumeOptions = {
  now?: Date;
  /** Keep false in tests so the sweep cannot delete rows a test is asserting on. */
  sweep?: boolean;
};

const SWEEP_CHANCE = 0.02;

export function windowStartFor(now: Date, windowSeconds: number): Date {
  const size = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / size) * size);
}

export function retryAfterSeconds(now: Date, windowSeconds: number): number {
  const start = windowStartFor(now, windowSeconds).getTime();
  const end = start + windowSeconds * 1000;
  return Math.max(1, Math.ceil((end - now.getTime()) / 1000));
}

export async function consumeRateLimit(
  db: Db,
  bucket: string,
  rule: RateLimitRule,
  options: ConsumeOptions = {},
): Promise<RateLimitDecision> {
  const now = options.now ?? new Date();
  const windowStart = windowStartFor(now, rule.windowSeconds);

  try {
    const [row] = await db
      .insert(rateLimits)
      .values({ bucket, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimits.bucket, rateLimits.windowStart],
        set: { count: sql`${rateLimits.count} + 1` },
      })
      .returning({ count: rateLimits.count });

    const count = row?.count ?? 1;

    if (options.sweep !== false && Math.random() < SWEEP_CHANCE) {
      const cutoff = new Date(
        windowStart.getTime() - rule.windowSeconds * 2000,
      );
      await db.delete(rateLimits).where(lt(rateLimits.windowStart, cutoff));
    }

    if (count > rule.limit) {
      return {
        ok: false,
        retryAfterSeconds: retryAfterSeconds(now, rule.windowSeconds),
      };
    }
    return { ok: true, remaining: Math.max(0, rule.limit - count), degraded: false };
  } catch (error) {
    // Fail open: a broken counter must not take down login and downloads. The trade-off is
    // explicit — losing the limiter is better than losing the service, and the log is the
    // alerting hook.
    console.warn("[ratelimit] counter unavailable, allowing request", {
      bucket: bucket.split(":")[0],
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: true, remaining: null, degraded: true };
  }
}

/** Bucket keys are `<channel>:<subject-kind>:<subject>`; the raw subject is never a token. */
export function bucketKey(
  channel: string,
  subjectKind: "ip" | "account" | "token",
  subject: string,
): string {
  return `${channel}:${subjectKind}:${subject}`;
}
