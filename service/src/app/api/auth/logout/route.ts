import { getDb } from "@/db/client";
import {
  clearSessionCookie,
  readSessionCookie,
} from "@/lib/auth/cookies";
import { isSameOrigin, jsonError, routeError } from "@/lib/auth/http";
import {
  deleteSessionByToken,
  findSession,
  revokeAccountTokens,
} from "@/lib/auth/service";
import { getConfig } from "@/lib/config";
import { getRuntimeConfig } from "@/lib/settings/runtime";

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
    if (token) {
      const session = await findSession(db, token);
      if (session) {
        await revokeAccountTokens(db, getConfig(), session.account.id);
        await deleteSessionByToken(db, token);
      }
    }
    await clearSessionCookie();

    return Response.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}
