import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { changeAdminPassword } from "@/lib/admin/auth";
import { clearAdminSessionCookie } from "@/lib/admin/cookies";
import { deleteAdminSessionsForAdmin } from "@/lib/admin/session";
import { getAdminSession } from "@/lib/admin/guard";
import { adminErrorResponse, readJsonBody, stringField } from "@/lib/admin/http";
import { isSameOrigin, jsonError, requestIp } from "@/lib/auth/http";
import { getRuntimeConfig } from "@/lib/settings/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Changes the caller's own password. Every other session of this administrator is dropped:
 * a password change is the one moment we know the old credential may have leaked.
 */
export async function POST(request: Request) {
  try {
    const db = getDb();
    const { publicUrl } = await getRuntimeConfig(db);
    if (!isSameOrigin(request, publicUrl)) {
      return jsonError("cross_origin", 403);
    }

    const session = await getAdminSession(db);
    if (!session) return jsonError("unauthenticated", 401);

    const body = await readJsonBody(request);
    await changeAdminPassword(db, {
      adminId: session.admin.id,
      currentPassword: stringField(body, "currentPassword", { required: true, max: 256 }),
      newPassword: stringField(body, "newPassword", { required: true, max: 256 }),
      ip: requestIp(request),
    });

    const revoked = await deleteAdminSessionsForAdmin(db, session.admin.id);
    await clearAdminSessionCookie();

    return NextResponse.json({ ok: true, revokedSessions: revoked });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
