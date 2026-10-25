import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { setAdminStatus } from "@/lib/admin/accounts";
import { AdminError } from "@/lib/admin/errors";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse, readJsonBody, stringField } from "@/lib/admin/http";
import { requestIp } from "@/lib/auth/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Enables or disables an administrator. The last active one cannot be disabled. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const { id } = await params;
    const body = await readJsonBody(request);
    const status = stringField(body, "status", { required: true });
    if (status !== "active" && status !== "disabled") {
      throw new AdminError("invalid_status", 400, "status 只能是 active 或 disabled");
    }

    await setAdminStatus(db, {
      adminId: id,
      status,
      actorAdminId: auth.session.admin.id,
      ip: requestIp(request),
    });

    return NextResponse.json({ ok: true, status });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
