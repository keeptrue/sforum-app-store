import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse } from "@/lib/admin/http";
import { loadSystemHealth, summarizeHealth } from "@/lib/admin/system";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Read-only health snapshot for the console.
 *
 * Authorisation comes first and the payload is assembled by the same loader the page uses,
 * so the JSON and the rendered page can never disagree about what is broken. Every probe
 * already returns its own error instead of throwing, which is why this route is 200 even
 * when a subsystem is down — the client needs the partial picture, not a blanket 500.
 */
export async function GET(request: Request) {
  try {
    const auth = await authorizeAdminRequest(getDb(), request, { mutation: false });
    if (!auth.ok) return auth.response;

    const health = await loadSystemHealth();
    return NextResponse.json(
      { ...health, summary: summarizeHealth(health) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return adminErrorResponse(error);
  }
}
