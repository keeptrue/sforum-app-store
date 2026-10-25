import { getDb } from "@/db/client";
import { jsonError, requestIp } from "@/lib/auth/http";
import { findPendingClaim, markClaimed } from "@/lib/github/claims";
import { enforceChannelLimit } from "@/lib/ratelimit/enforce";
import { importProductFromRepo } from "@/lib/products/binding";
import {
  authorizeDashboardRequest,
  jsonOk,
  ProductError,
  productErrorResponse,
} from "@/lib/products/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * Claim a waiting release.
 *
 * Claiming re-reads the release itself (`importProductFromRepo`) instead of trusting the
 * manifest name and tag stored on the claim: the claim is a pointer, the release is the
 * truth. The claim is closed afterwards even when the manifest id changed since it was
 * recorded — the developer answered the proposal either way.
 */
export async function POST(request: Request, context: Context) {
  try {
    const db = getDb();
    const auth = await authorizeDashboardRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const { id } = await context.params;
    const claim = await findPendingClaim(db, auth.accountId, id);
    if (!claim) return jsonError("claim_not_found", 404);

    const limited = await enforceChannelLimit(
      db,
      "repo",
      `repo:account:${auth.accountId}`,
    );
    if (limited) return limited;

    const result = await importProductFromRepo(db, {
      accountId: auth.accountId,
      repoId: claim.repoId,
      ip: requestIp(request),
    });

    const closed = await markClaimed(db, {
      claimId: claim.id,
      productId: result.product.id,
      accountId: auth.accountId,
    });
    if (!closed) {
      // Another request closed it between the read and this write; the product exists, so
      // the honest answer is a conflict rather than a second success.
      throw new ProductError("claim_already_settled", 409);
    }

    return jsonOk({ product: result.product, created: result.created, issues: result.issues });
  } catch (error) {
    return productErrorResponse(error);
  }
}
