import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse } from "@/lib/admin/http";
import { requestIp } from "@/lib/auth/http";
import { verifyGithubApp } from "@/lib/github/app-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Identity probe: an App JWT against `GET /app`. A failure is recorded and returned verbatim
 * so the console can show exactly what GitHub said; nothing is enforced here.
 */
export async function POST(request: Request) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const result = await verifyGithubApp(db, {
      adminId: auth.session.admin.id,
      ip: requestIp(request),
    });

    return NextResponse.json(result);
  } catch (error) {
    return adminErrorResponse(error);
  }
}
