import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { revokeAdminSessions } from "@/lib/admin/accounts";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse } from "@/lib/admin/http";
import { requestIp } from "@/lib/auth/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Signs an administrator out everywhere. Their password and role are untouched. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const { id } = await params;
    const revoked = await revokeAdminSessions(db, {
      adminId: id,
      actorAdminId: auth.session.admin.id,
      ip: requestIp(request),
    });

    return NextResponse.json({ ok: true, revoked });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
