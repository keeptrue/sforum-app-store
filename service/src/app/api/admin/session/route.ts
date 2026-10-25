import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { clearAdminSessionCookie, readAdminSessionCookie, setAdminSessionCookie } from "@/lib/admin/cookies";
import { loginAdmin } from "@/lib/admin/auth";
import { getAdminSession } from "@/lib/admin/guard";
import { adminErrorResponse, readJsonBody, stringField } from "@/lib/admin/http";
import { deleteAdminSessionByToken } from "@/lib/admin/session";
import { requestIp } from "@/lib/auth/http";
import { getConfig } from "@/lib/config";
import { enforceChannelLimit, ipBucket } from "@/lib/ratelimit/enforce";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Current administrator, or 401. Used by the console to refresh the shell after actions. */
export async function GET() {
  const session = await getAdminSession(getDb());
  if (!session) {
    return NextResponse.json({ code: "unauthenticated" }, { status: 401 });
  }
  return NextResponse.json({
    id: session.admin.id,
    username: session.admin.username,
    displayName: session.admin.displayName,
    mustChangePassword: session.admin.mustChangePassword,
    expiresAt: session.expiresAt.toISOString(),
  });
}

export async function POST(request: Request) {
  try {
    const config = getConfig();
    const db = getDb();

    const limited = await enforceChannelLimit(
      db,
      "admin-login",
      ipBucket(request, "admin-login"),
    );
    if (limited) return limited;

    const body = await readJsonBody(request);
    const result = await loginAdmin(db, config, {
      username: stringField(body, "username", { required: true, max: 64 }),
      password: stringField(body, "password", { required: true, max: 256 }),
      ip: requestIp(request),
      userAgent: request.headers.get("user-agent"),
    });

    await setAdminSessionCookie(result.token, result.expiresAt);
    return NextResponse.json({
      username: result.username,
      mustChangePassword: result.mustChangePassword,
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

/** Signs out this device only; other sessions are ended from the accounts page. */
export async function DELETE() {
  const db = getDb();
  const token = await readAdminSessionCookie();
  if (token) await deleteAdminSessionByToken(db, token);
  await clearAdminSessionCookie();
  return NextResponse.json({ ok: true });
}
