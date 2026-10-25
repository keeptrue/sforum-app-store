import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse } from "@/lib/admin/http";
import { requestIp } from "@/lib/auth/http";
import { removeGithubAppKey } from "@/lib/github/app-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The "remove" half of a key rotation. The last key is refused with 409 `last_key`. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ appKeyId: string }> },
) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const { appKeyId } = await params;
    const result = await removeGithubAppKey(db, appKeyId, {
      adminId: auth.session.admin.id,
      ip: requestIp(request),
    });

    return NextResponse.json({ ok: true, remaining: result.remaining });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
