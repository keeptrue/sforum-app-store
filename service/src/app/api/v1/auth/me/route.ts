import { getDb } from "@/db/client";
import {
  accountView,
  authenticateAccountToken,
  readBearerToken,
} from "@/lib/install-auth/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * "Who am I?" for a connected plugin.
 *
 * The plugin calls this on demand (a status refresh, a reconnect check); it is not on the
 * install hot path, so the extra round trip buys a truthful "connected as @x" instead of a
 * cached guess.
 */
export async function GET(request: Request): Promise<Response> {
  const result = await authenticateAccountToken(getDb(), readBearerToken(request));
  if (!result.ok) {
    return Response.json(
      { code: result.code, message: result.code },
      { status: 401, headers: NO_STORE },
    );
  }
  return Response.json(
    {
      account: accountView(result.account),
      expires_at: result.token.expiresAt.toISOString(),
      scope: result.token.scope,
    },
    { headers: NO_STORE },
  );
}
