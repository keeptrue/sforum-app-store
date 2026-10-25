import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { setModeratorRole } from "@/lib/admin/accounts";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse } from "@/lib/admin/http";
import { requestIp } from "@/lib/auth/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Grants `moderator`. There is no way to grant `admin` here — that identity is local. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const { id } = await params;
    await setModeratorRole(db, {
      accountId: id,
      granted: true,
      actorAdminId: auth.session.admin.id,
      ip: requestIp(request),
    });

    return NextResponse.json({ ok: true, role: "moderator", granted: true });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const { id } = await params;
    await setModeratorRole(db, {
      accountId: id,
      granted: false,
      actorAdminId: auth.session.admin.id,
      ip: requestIp(request),
    });

    return NextResponse.json({ ok: true, role: "moderator", granted: false });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
