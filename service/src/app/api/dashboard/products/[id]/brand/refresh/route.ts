import { getDb } from "@/db/client";
import { requestIp } from "@/lib/auth/http";
import { enforceChannelLimit } from "@/lib/ratelimit/enforce";
import { refreshProductBrand } from "@/lib/products/brand";
import {
  authorizeDashboardRequest,
  jsonOk,
  productErrorResponse,
  requireOwnedProduct,
} from "@/lib/products/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * Re-read `brand/icon.png` and `brand/social-preview.png` from the bound repository.
 *
 * The developer-facing counterpart of the release/push/sweep triggers: "I just pushed a new
 * icon, show me now". Both slots are refreshed in one call because they are two files in one
 * directory — but they succeed or fail independently, and the response says which.
 *
 * Shares the `repo` rate-limit channel with every other GitHub-touching developer action,
 * so a stuck button cannot turn into a crawl of the Contents API.
 */
export async function POST(request: Request, context: Context) {
  try {
    const db = getDb();
    const auth = await authorizeDashboardRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const { id } = await context.params;
    // Ownership first: someone else's product must 404 before any GitHub traffic happens.
    await requireOwnedProduct(db, id, auth.accountId);

    const limited = await enforceChannelLimit(
      db,
      "repo",
      `repo:account:${auth.accountId}`,
    );
    if (limited) return limited;

    // An unbound product answers `no_repo` for both slots without touching the network.
    const result = await refreshProductBrand(db, { productId: id });

    void requestIp(request);

    return jsonOk(result);
  } catch (error) {
    return productErrorResponse(error);
  }
}
