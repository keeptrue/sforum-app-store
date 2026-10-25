import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { resetAdminPassword } from "@/lib/admin/auth";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse, readJsonBody, stringField } from "@/lib/admin/http";
import { requestIp } from "@/lib/auth/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Sets another administrator's password and forces a change at their next login. Their
 * existing sessions are dropped — a reset is what you do when a credential is suspect.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const { id } = await params;
    const body = await readJsonBody(request);
    await resetAdminPassword(db, {
      adminId: id,
      newPassword: stringField(body, "newPassword", { required: true, max: 256 }),
      actorAdminId: auth.session.admin.id,
      ip: requestIp(request),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
