import { getDb } from "@/db/client";
import { jsonError } from "@/lib/auth/http";
import {
  authorizeDashboardRequest,
  jsonOk,
  listDashboardProducts,
  productErrorResponse,
} from "@/lib/products/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const db = getDb();
    const auth = await authorizeDashboardRequest(db, request, {
      mutation: false,
    });
    if (!auth.ok) return auth.response;

    const products = await listDashboardProducts(db, auth.accountId);
    return jsonOk({ products });
  } catch (error) {
    return productErrorResponse(error);
  }
}

/**
 * Manual creation is closed.
 *
 * A product's identity now comes from GitHub: the extension id, name and kind are read from
 * the manifest inside a release, and the introduction is the repository README. Letting a
 * client post an id by hand would create a row that no repository can ever claim, which is
 * exactly the drift this change removes.
 *
 * The route stays (instead of disappearing into a 404) so an old client gets a precise
 * answer: `410` with a code that names the replacement, not "not found".
 */
export async function POST(request: Request) {
  const auth = await authorizeDashboardRequest(getDb(), request, {
    mutation: true,
  });
  if (!auth.ok) return auth.response;
  return jsonError("manual_create_disabled", 410);
}
