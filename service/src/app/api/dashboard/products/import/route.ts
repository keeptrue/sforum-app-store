import { getDb } from "@/db/client";
import { jsonError, requestIp } from "@/lib/auth/http";
import { enforceChannelLimit } from "@/lib/ratelimit/enforce";
import { importProductFromRepo } from "@/lib/products/binding";
import {
  authorizeDashboardRequest,
  jsonOk,
  productErrorResponse,
} from "@/lib/products/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Create a product from a repository's latest release.
 *
 * The manifest inside the release supplies `extension_id`, name and kind — the developer
 * never types an id that GitHub then has to match. Re-importing a repository whose product
 * already exists and is still unbound adopts it instead of failing.
 */
export async function POST(request: Request) {
  try {
    const db = getDb();
    const auth = await authorizeDashboardRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const body = (await request.json().catch(() => undefined)) as
      | { repoId?: unknown }
      | undefined;
    if (!body) return jsonError("invalid_json", 400);

    const repoId = Number(body.repoId);
    if (!Number.isSafeInteger(repoId) || repoId <= 0) {
      return jsonError("invalid_repo_id", 400);
    }

    const limited = await enforceChannelLimit(
      db,
      "repo",
      `repo:account:${auth.accountId}`,
    );
    if (limited) return limited;

    const result = await importProductFromRepo(db, {
      accountId: auth.accountId,
      repoId,
      ip: requestIp(request),
    });
    return jsonOk(result, result.created ? 201 : 200);
  } catch (error) {
    return productErrorResponse(error);
  }
}
