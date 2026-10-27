import { getDb } from "@/db/client";
import { ACCOUNT_TOKEN_TTL_SECONDS } from "@/lib/install-auth/constants";
import { getRuntimeConfig } from "@/lib/settings/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The one thing a plugin asks before it decides whether to show "connect store".
 *
 * Anonymous on purpose: a plugin that has not connected yet has no credential, and this
 * answer contains no account data. `anonymous` is also the safe default — an old store that
 * has never heard of this route answers 404, which the plugin reads as "no gate".
 */
export async function GET(): Promise<Response> {
  const db = getDb();
  const runtime = await getRuntimeConfig(db);
  return Response.json(
    {
      mode: runtime.downloadAuthMode,
      token_ttl_seconds: ACCOUNT_TOKEN_TTL_SECONDS,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
