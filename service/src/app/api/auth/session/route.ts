import { getDb } from "@/db/client";
import { readSessionCookie } from "@/lib/auth/cookies";
import { jsonError, routeError } from "@/lib/auth/http";
import { findSession } from "@/lib/auth/service";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    getConfig();
    const token = await readSessionCookie();
    if (!token) return jsonError("unauthenticated", 401);

    const session = await findSession(getDb(), token);
    if (!session) return jsonError("unauthenticated", 401);

    return Response.json(
      {
        account: session.account,
        roles: session.roles,
        expiresAt: session.expiresAt.toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}
