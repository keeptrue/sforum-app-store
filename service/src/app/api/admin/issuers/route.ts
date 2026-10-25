import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse, readJsonBody, stringField } from "@/lib/admin/http";
import { createIssuer, listIssuers } from "@/lib/admin/issuers";
import { requestIp } from "@/lib/auth/http";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: false });
    if (!auth.ok) return auth.response;

    return NextResponse.json({ issuers: await listIssuers(db) });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const config = getConfig();
    const auth = await authorizeAdminRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const body = await readJsonBody(request);
    await createIssuer(
      db,
      config,
      {
        issuerKey: stringField(body, "issuerKey", { required: true, max: 32 }),
        displayName: stringField(body, "displayName", { max: 120 }),
        baseUrl: stringField(body, "baseUrl", { required: true, max: 500 }),
        clientId: stringField(body, "clientId", { required: true, max: 128 }),
        clientSecret: stringField(body, "clientSecret", { required: true, max: 256 }),
        scopes: Array.isArray(body.scopes)
          ? body.scopes.filter((item): item is string => typeof item === "string")
          : [],
      },
      { adminId: auth.session.admin.id, ip: requestIp(request) },
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
