import { getDb } from "@/db/client";
import {
  authorizeDashboardRequest,
  jsonOk,
  productErrorResponse,
} from "@/lib/products/service";
import { listPendingClaims } from "@/lib/github/claims";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Releases waiting for an owner.
 *
 * A repository published an `extension_id` that no product owns. Only claims behind the
 * account's own `active` installations are listed — the queue never shows one developer
 * another developer's repository.
 */
export async function GET(request: Request) {
  try {
    const db = getDb();
    const auth = await authorizeDashboardRequest(db, request, { mutation: false });
    if (!auth.ok) return auth.response;

    const claims = await listPendingClaims(db, auth.accountId);
    return jsonOk({ claims });
  } catch (error) {
    return productErrorResponse(error);
  }
}
