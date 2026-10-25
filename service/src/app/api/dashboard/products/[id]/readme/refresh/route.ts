import { getDb } from "@/db/client";
import { requestIp } from "@/lib/auth/http";
import { enforceChannelLimit } from "@/lib/ratelimit/enforce";
import { refreshProductReadme } from "@/lib/github/readme";
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
 * Re-read the README from the repository.
 *
 * The mark is *not* refreshed here any more: it has its own endpoint and its own button
 * (`/brand/refresh`), because the two are separate resources with separate failure states and
 * the README button silently swallowing a preview failure was a bug, not a feature.
 *
 * It runs synchronously because the person clicking it is waiting, and it shares the `repo`
 * rate-limit channel with every other GitHub-touching developer action. The HTML is not
 * echoed back: the caller refreshes the page, which reads the row this request just wrote.
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

    const readme = await refreshProductReadme(db, {
      productId: id,
      actorAccountId: auth.accountId,
    });

    void requestIp(request);

    return jsonOk({
      readme: readme.ok
        ? {
            ok: true,
            path: readme.path,
            blobSha: readme.blobSha,
            changed: readme.changed,
            fetchedAt: readme.fetchedAt.toISOString(),
            sourceUrl: readme.sourceUrl,
          }
        : readme,
    });
  } catch (error) {
    return productErrorResponse(error);
  }
}
