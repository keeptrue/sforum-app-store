import type { Db } from "@/db/client";
import { jsonError, rateLimitedResponse, requestIp } from "@/lib/auth/http";
import { getRuntimeConfig } from "@/lib/settings/runtime";
import { consumeRateLimit } from "./limiter";
import type { RateLimitChannel, RateLimitRule } from "./rules";

/**
 * One call per protected entry point: returns a ready 429 response, or null when the
 * request may proceed. Keeping this in one place means routes never hand-roll their own
 * error shape or forget `Retry-After`.
 */
export async function enforceChannelLimit(
  db: Db,
  channel: RateLimitChannel,
  subject: string,
  options: { rule?: RateLimitRule } = {},
): Promise<Response | null> {
  // Console overrides (`store_settings.rate_limits`) win over env, and a save is visible on the
  // next request in this process. Reading it here keeps one resolution path for every channel.
  const rule = options.rule ?? (await getRuntimeConfig(db)).rateLimits[channel];
  const decision = await consumeRateLimit(db, subject, rule);
  if (!decision.ok) return rateLimitedResponse(decision.retryAfterSeconds);
  return null;
}

/** `login:ip:<ip>` — falls back to a literal "unknown" bucket when no IP header is present. */
export function ipBucket(request: Request, channel: RateLimitChannel): string {
  const ip = requestIp(request) ?? "unknown";
  return `${channel}:ip:${ip}`;
}

export function missingSubjectResponse(): Response {
  return jsonError("missing_subject", 400);
}
