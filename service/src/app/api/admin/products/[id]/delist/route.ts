import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse, readJsonBody, stringField } from "@/lib/admin/http";
import { forceDelistProduct } from "@/lib/admin/products";
import { requestIp } from "@/lib/auth/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Takes a published product off the catalog regardless of who owns it. */
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

    await forceDelistProduct(db, {
      productId: id,
      reason: stringField(body, "reason", { required: true, max: 500 }),
      actorAdminId: auth.session.admin.id,
      ip: requestIp(request),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
