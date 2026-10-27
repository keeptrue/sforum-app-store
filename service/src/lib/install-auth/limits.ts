import type { Db } from "@/db/client";
import { ipBucket } from "@/lib/ratelimit/enforce";
import { enforceChannelLimit } from "@/lib/ratelimit/enforce";
import { consumeRateLimit } from "@/lib/ratelimit/limiter";
import { AUTH_POLL_INTERVAL_SECONDS } from "./constants";

/**
 * Rate limits for the three anonymous install-gate endpoints.
 *
 * They are separate from `download-ip` on purpose: the connect flow is bursty (a forum
 * installs several extensions in a row) while a download is one request, and sharing a bucket
 * would make one throttle the other.
 */

/** `POST /api/v1/auth/requests` — per IP, because an unauthenticated caller has nothing else. */
export async function enforceAuthStartLimit(
  db: Db,
  request: Request,
): Promise<Response | null> {
  return enforceChannelLimit(db, "install-auth-start", ipBucket(request, "install-auth-start"));
}

/**
 * `GET /api/v1/auth/requests/{id}` — per request id, plus a hard floor of one poll per
 * advertised interval.
 *
 * The floor is what `slow_down` means here: a plugin that ignores the interval it was given
 * gets a 429 with `Retry-After` instead of a free spin against the database. Fixed 2-second
 * windows let a straddling pair through, which is fine — the plugin's own timer is the real
 * pacing, this is the brake on a hot loop.
 */
export async function enforcePollLimit(
  db: Db,
  requestId: string,
): Promise<Response | null> {
  const limited = await enforceChannelLimit(
    db,
    "install-auth-poll",
    `install-auth-poll:request:${requestId}`,
  );
  if (limited) return limited;

  const floor = await consumeRateLimit(
    db,
    `install-auth-poll:floor:${requestId}`,
    { limit: 1, windowSeconds: AUTH_POLL_INTERVAL_SECONDS },
  );
  if (!floor.ok) return slowDownResponse(floor.retryAfterSeconds);
  return null;
}

/** `POST /api/v1/auth/requests/{id}/token` — per request id; one successful exchange is all it takes. */
export async function enforceTokenLimit(
  db: Db,
  requestId: string,
): Promise<Response | null> {
  return enforceChannelLimit(
    db,
    "install-auth-token",
    `install-auth-token:request:${requestId}`,
  );
}

function slowDownResponse(retryAfterSeconds: number): Response {
  return Response.json(
    { code: "slow_down", message: "poll faster than the advertised interval" },
    {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(retryAfterSeconds),
      },
    },
  );
}
