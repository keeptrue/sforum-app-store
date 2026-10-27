import { getDb } from "@/db/client";
import { readBearerToken, revokeAccountTokenByBearer } from "@/lib/install-auth/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Disconnect. Always 204.
 *
 * Idempotent on purpose: a plugin whose token already expired, or that retries after a lost
 * response, must not have to distinguish "revoked now" from "already gone" — both mean the
 * same thing to the operator, and a 401 here would push the plugin into a reconnect loop it
 * cannot win. The bearer is still required to be *shaped* like a token so an empty body cannot
 * be used to probe the endpoint.
 */
export async function POST(request: Request): Promise<Response> {
  // Revoking an expired-but-unrevoked token still matters: it is the state an operator is
  // most likely to be cleaning up, so this does not go through the "is it usable" check.
  await revokeAccountTokenByBearer(getDb(), readBearerToken(request));
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "private, no-store" },
  });
}
