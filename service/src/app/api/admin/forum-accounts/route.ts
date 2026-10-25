import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { listForumAccounts } from "@/lib/admin/accounts";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse } from "@/lib/admin/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Forum identities, searchable. Separate from administrators on purpose. */
export async function GET(request: Request) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: false });
    if (!auth.ok) return auth.response;

    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const offset = Number(url.searchParams.get("offset") ?? "0");

    const { rows, total } = await listForumAccounts(db, {
      query,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });

    return NextResponse.json({ accounts: rows, total });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
