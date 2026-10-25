import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { readSessionCookie, setGithubInstallCookie } from "@/lib/auth/cookies";
import { jsonError, routeError } from "@/lib/auth/http";
import { findSession } from "@/lib/auth/service";
import { getConfig } from "@/lib/config";
import { getRuntimeConfig } from "@/lib/settings/runtime";
import {
  GithubAppConfigError,
  requireGithubConfig,
} from "@/lib/github/app-config";
import { encodeInstallState } from "@/lib/github/install-state";
import { enforceChannelLimit } from "@/lib/ratelimit/enforce";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const config = getConfig();
    const db = getDb();
    const { publicUrl } = await getRuntimeConfig(db);
    // The slug decides which App's install page we send the user to; it comes from the console.
    let github;
    try {
      github = await requireGithubConfig(db);
    } catch (error) {
      if (error instanceof GithubAppConfigError) {
        return jsonError(error.code, 503, error.message);
      }
      throw error;
    }

    const token = await readSessionCookie();
    const session = token ? await findSession(db, token) : null;
    if (!session) {
      const login = new URL("/api/auth/sforum/start", publicUrl);
      login.searchParams.set("redirect", "/api/github/install/start");
      return NextResponse.redirect(login);
    }

    // Connecting a repository opens a GitHub installation flow; limit it per account so a
    // script cannot churn installation states.
    const limited = await enforceChannelLimit(
      db,
      "repo",
      `repo:account:${session.account.id}`,
    );
    if (limited) return limited;

    const state = encodeInstallState(
      {
        accountId: session.account.id,
        nonce: randomUUID(),
        exp: Math.floor(Date.now() / 1000) + 10 * 60,
      },
      config.sessionSecret,
    );
    await setGithubInstallCookie(state, 10 * 60);

    const install = new URL(
      `https://github.com/apps/${github.slug}/installations/new`,
    );
    install.searchParams.set("state", state);
    return NextResponse.redirect(install);
  } catch (error) {
    return routeError(error);
  }
}
