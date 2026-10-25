import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse, readJsonBody, stringField } from "@/lib/admin/http";
import { requestIp } from "@/lib/auth/http";
import { getConfig } from "@/lib/config";
import { addGithubAppKey } from "@/lib/github/app-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The "add" half of a key rotation: the new key starts signing, the old one stays. */
export async function POST(request: Request) {
  try {
    const db = getDb();
    const config = getConfig();
    const auth = await authorizeAdminRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const body = await readJsonBody(request);
    const result = await addGithubAppKey(
      db,
      config,
      { privateKeyPem: stringField(body, "privateKeyPem", { required: true, max: 16384 }) },
      { adminId: auth.session.admin.id, ip: requestIp(request) },
    );

    return NextResponse.json({ ok: true, appKeyId: result.appKeyId });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
