import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse } from "@/lib/admin/http";
import { verifyIssuer } from "@/lib/admin/issuers";
import { requestIp } from "@/lib/auth/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Reachability probe. A failure is reported, never enforced. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const { key } = await params;
    const result = await verifyIssuer(db, key, {
      adminId: auth.session.admin.id,
      ip: requestIp(request),
    });

    return NextResponse.json(result);
  } catch (error) {
    return adminErrorResponse(error);
  }
}
