import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { AdminError } from "@/lib/admin/errors";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse, readJsonBody } from "@/lib/admin/http";
import { retireIssuer, updateIssuer } from "@/lib/admin/issuers";
import { requestIp } from "@/lib/auth/http";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const db = getDb();
    const config = getConfig();
    const auth = await authorizeAdminRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const { key } = await params;
    const body = await readJsonBody(request);
    const status = body.status;
    if (status !== undefined && status !== "active" && status !== "retired") {
      throw new AdminError("invalid_status", 400, "status 只能是 active 或 retired");
    }

    await updateIssuer(
      db,
      config,
      key,
      {
        displayName: typeof body.displayName === "string" ? body.displayName : undefined,
        baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
        clientId: typeof body.clientId === "string" ? body.clientId : undefined,
        // An empty string means "leave the stored secret alone"; a value rotates it.
        clientSecret:
          typeof body.clientSecret === "string" && body.clientSecret.trim()
            ? body.clientSecret
            : undefined,
        scopes: Array.isArray(body.scopes)
          ? body.scopes.filter((item): item is string => typeof item === "string")
          : undefined,
        status: status as "active" | "retired" | undefined,
      },
      { adminId: auth.session.admin.id, ip: requestIp(request) },
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

/** Soft delete: the row stays because `accounts.issuer_key` references it. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const { key } = await params;
    const result = await retireIssuer(db, key, {
      adminId: auth.session.admin.id,
      ip: requestIp(request),
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
