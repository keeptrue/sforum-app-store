import { getDb } from "@/db/client";
import { readSessionCookie } from "@/lib/auth/cookies";
import { isSameOrigin, jsonError, routeError } from "@/lib/auth/http";
import { findSession, refreshAccountTokens } from "@/lib/auth/service";
import { getConfig } from "@/lib/config";
import { getRuntimeConfig } from "@/lib/settings/runtime";
import { OAuthError } from "@/lib/oauth/provider";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const db = getDb();
    const { publicUrl } = await getRuntimeConfig(db);
    if (!isSameOrigin(request, publicUrl)) {
      return jsonError("origin_mismatch", 403);
    }

    const token = await readSessionCookie();
    if (!token) return jsonError("unauthenticated", 401);

    const session = await findSession(db, token);
    if (!session) return jsonError("unauthenticated", 401);

    const result = await refreshAccountTokens(db, getConfig(), session.account.id);
    return Response.json(
      { ok: true, expiresAt: result.expiresAt?.toISOString() ?? null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof OAuthError) {
      return jsonError(error.code, 401, error.detail);
    }
    return routeError(error);
  }
}
