import { getDb } from "@/db/client";
import { jsonError } from "@/lib/auth/http";
import {
  GithubAppConfigError,
  requireGithubConfig,
} from "@/lib/github/app-config";
import { GithubAppClient } from "@/lib/github/client";
import {
  GithubRepoError,
  listAccountInstallations,
  syncInstallationRepos,
} from "@/lib/github/repos";
import { enforceChannelLimit } from "@/lib/ratelimit/enforce";
import {
  authorizeDashboardRequest,
  jsonOk,
  productErrorResponse,
} from "@/lib/products/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Mirror one installation's repository list from GitHub.
 *
 * The installation id comes from the browser, so it is checked against the account's own
 * installations first — a valid installation id belonging to someone else is a 404, not a
 * silent sync. The `repo` channel bounds how often a script can make the store talk to
 * GitHub.
 */
export async function POST(request: Request) {
  try {
    const db = getDb();
    const auth = await authorizeDashboardRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const body = (await request.json().catch(() => undefined)) as
      | { installationId?: unknown }
      | undefined;
    if (!body) return jsonError("invalid_json", 400);

    const installationId = Number(body.installationId);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      return jsonError("invalid_installation_id", 400);
    }

    const installations = await listAccountInstallations(db, auth.accountId);
    const owned = installations.find((row) => row.installationId === installationId);
    if (!owned) return jsonError("installation_not_found", 404);
    if (owned.status !== "active") return jsonError("installation_suspended", 409);

    const limited = await enforceChannelLimit(
      db,
      "repo",
      `repo:account:${auth.accountId}`,
    );
    if (limited) return limited;

    let github;
    try {
      github = await requireGithubConfig(db);
    } catch (error) {
      if (error instanceof GithubAppConfigError) {
        return jsonError(error.code, 503, error.message);
      }
      throw error;
    }

    const written = await syncInstallationRepos(
      db,
      new GithubAppClient(github),
      installationId,
    );
    return jsonOk({ installationId, repositories: written });
  } catch (error) {
    if (error instanceof GithubRepoError) {
      return jsonError(error.code, error.status, error.message);
    }
    return productErrorResponse(error);
  }
}
