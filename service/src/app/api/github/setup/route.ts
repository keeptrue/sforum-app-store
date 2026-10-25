import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import {
  clearGithubInstallCookie,
  readGithubInstallCookie,
} from "@/lib/auth/cookies";
import { jsonError, routeError } from "@/lib/auth/http";
import { getConfig } from "@/lib/config";
import { getRuntimeConfig } from "@/lib/settings/runtime";
import {
  GithubAppConfigError,
  requireGithubConfig,
} from "@/lib/github/app-config";
import { GithubAppClient } from "@/lib/github/client";
import { verifyInstallState } from "@/lib/github/install-state";
import { recordInstallation } from "@/lib/github/installations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const config = getConfig();
    const db = getDb();
    const { publicUrl } = await getRuntimeConfig(db);
    let github;
    try {
      github = await requireGithubConfig(db);
    } catch (error) {
      if (error instanceof GithubAppConfigError) {
        return jsonError(error.code, 503, error.message);
      }
      throw error;
    }

    const url = new URL(request.url);
    const installationId = Number(url.searchParams.get("installation_id"));
    const state = url.searchParams.get("state");
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      return jsonError("invalid_installation_id", 400);
    }
    if (!state) return jsonError("missing_state", 400);

    const cookie = await readGithubInstallCookie();
    const payload = verifyInstallState(cookie, state, config.sessionSecret);
    if (!payload) {
      return jsonError("state_mismatch", 400);
    }

    const client = new GithubAppClient(github);
    const installation = await client.getInstallation(installationId);

    await recordInstallation(db, {
      installationId,
      accountId: payload.accountId,
      accountLogin: installation.account.login,
    });

    await clearGithubInstallCookie();
    return NextResponse.redirect(new URL("/", publicUrl), 303);
  } catch (error) {
    return routeError(error);
  }
}
