import { getDb } from "@/db/client";
import {
  authorizeDashboardRequest,
  jsonOk,
  productErrorResponse,
} from "@/lib/products/service";
import { listSelectableRepos } from "@/lib/github/repos";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Repositories this account may bind: mirrored locally, behind one of its `active`
 * installations, not disconnected upstream.
 *
 * Nothing upstream (clone URL, download URL, token) is part of the payload — only the
 * fields the picker renders.
 */
export async function GET(request: Request) {
  try {
    const db = getDb();
    const auth = await authorizeDashboardRequest(db, request, { mutation: false });
    if (!auth.ok) return auth.response;

    const repos = await listSelectableRepos(db, auth.accountId);
    return jsonOk({ repos });
  } catch (error) {
    return productErrorResponse(error);
  }
}
