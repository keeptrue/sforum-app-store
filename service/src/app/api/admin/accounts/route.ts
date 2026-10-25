import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { createAdmin, listAdmins } from "@/lib/admin/accounts";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse, readJsonBody, stringField } from "@/lib/admin/http";
import { requestIp } from "@/lib/auth/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const db = getDb();
  const auth = await authorizeAdminRequest(db, request, { mutation: false });
  if (!auth.ok) return auth.response;

  return NextResponse.json({ admins: await listAdmins(db) });
}

/** Creates another administrator with an initial password that must be changed at login. */
export async function POST(request: Request) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const body = await readJsonBody(request);
    const created = await createAdmin(db, {
      username: stringField(body, "username", { required: true, max: 64 }),
      password: stringField(body, "password", { required: true, max: 256 }),
      displayName: stringField(body, "displayName", { max: 120 }),
      actorAdminId: auth.session.admin.id,
      ip: requestIp(request),
    });

    return NextResponse.json(created);
  } catch (error) {
    return adminErrorResponse(error);
  }
}
