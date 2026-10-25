import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse, readJsonBody, stringField } from "@/lib/admin/http";
import { forceYankVersion } from "@/lib/admin/products";
import { requestIp } from "@/lib/auth/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Yanks one published version regardless of owner. Existing signed links die immediately
 * (the download resolver re-checks state), and the product's latest version is recomputed.
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

    await forceYankVersion(db, {
      versionId: id,
      reason: stringField(body, "reason", { required: true, max: 500 }),
      actorAdminId: auth.session.admin.id,
      ip: requestIp(request),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
