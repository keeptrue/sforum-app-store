import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import {
  AUDIT_PAGE_SIZE,
  auditFilterValues,
  auditFilters,
  decodeAuditCursor,
  loadAuditPage,
} from "@/lib/admin/audit";
import { AdminError } from "@/lib/admin/errors";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse } from "@/lib/admin/http";

/**
 * JSON surface of the audit trail. Read-only by design: `audit_log` is evidence, and nothing in
 * the console may edit or delete it.
 *
 * Paging is one stateless `cursor` (the page itself carries a stack — see `parseAuditTrail`).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: false });
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const rawCursor = searchParams.get("cursor");
    const cursor = rawCursor === null ? null : decodeAuditCursor(rawCursor);
    // A cursor we cannot read would silently serve page one again, which reads as "the data
    // changed" to a machine caller. Say so instead.
    if (rawCursor !== null && cursor === null) {
      throw new AdminError("invalid_cursor", 400, "游标无法解析");
    }

    const page = await loadAuditPage(db, {
      filters: auditFilters(auditFilterValues((name) => searchParams.get(name))),
      cursor,
      limit: AUDIT_PAGE_SIZE,
    });

    return NextResponse.json({
      entries: page.entries.map((entry) => ({
        ...entry,
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
