import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { loginAdmin } from "@/lib/admin/auth";
import { setAdminSessionCookie } from "@/lib/admin/cookies";
import { getAdminSession } from "@/lib/admin/guard";
import { adminErrorResponse, readJsonBody, stringField } from "@/lib/admin/http";
import { hasAdmin, registerFirstAdmin } from "@/lib/admin/setup";
import { requestIp } from "@/lib/auth/http";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Creates the first administrator. Refused once any administrator exists — the route is not
 * an "add an admin" API; that lives behind an authenticated session.
 */
export async function POST(request: Request) {
  try {
    const config = getConfig();
    const db = getDb();

    if (await hasAdmin(db)) {
      return NextResponse.json(
        { code: "already_initialized", message: "管理员已存在，注册入口已关闭" },
        { status: 409 },
      );
    }

    const body = await readJsonBody(request);
    const created = await registerFirstAdmin(db, config, {
      token: stringField(body, "token", { required: true, max: 256 }),
      username: stringField(body, "username", { required: true, max: 64 }),
      password: stringField(body, "password", { required: true, max: 256 }),
      ip: requestIp(request),
      userAgent: request.headers.get("user-agent"),
    });

    // Sign the new administrator in: registration and first login are one action.
    const session = await loginAdmin(db, config, {
      username: created.username,
      password: stringField(body, "password"),
      ip: requestIp(request),
      userAgent: request.headers.get("user-agent"),
    });
    await setAdminSessionCookie(session.token, session.expiresAt);

    return NextResponse.json({ username: created.username, id: created.id });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

/** Whether the console still needs its first administrator (used by the storefront hint). */
export async function GET() {
  const session = await getAdminSession(getDb());
  return NextResponse.json({
    initialized: await hasAdmin(getDb()),
    authenticated: Boolean(session),
  });
}
