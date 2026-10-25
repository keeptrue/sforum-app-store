import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { AdminError } from "@/lib/admin/errors";
import { adminErrorResponse, readJsonBody, stringField } from "@/lib/admin/http";
import { setGithubManifestCookie } from "@/lib/auth/cookies";
import { getConfig } from "@/lib/config";
import {
  buildGithubAppManifest,
  defaultAppName,
  encodeManifestState,
  isGithubDotCom,
  MANIFEST_STATE_TTL_SECONDS,
  manifestCallbackUrl,
  manifestStartUrl,
  webHostFor,
} from "@/lib/github/manifest";
import { getGithubAppView, githubSetupUrl, githubWebhookUrl } from "@/lib/github/app-config";
import { getRuntimeConfig } from "@/lib/settings/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GitHub logins: alphanumerics and single hyphens, never leading or trailing. */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * Step 1 of the manifest handshake, answered as JSON instead of a redirect.
 *
 * The browser cannot be redirected into this: GitHub wants the manifest as a POST *body* on
 * `github.com/settings/apps/new`, and a 303 would drop it. So the console fetches the target
 * URL plus the manifest JSON, then builds a real form and submits it. What this route
 * contributes is the part only the server knows — the effective public URL, and a `state`
 * bound to the admin who clicked.
 */
export async function POST(request: Request) {
  try {
    const db = getDb();
    const config = getConfig();
    const auth = await authorizeAdminRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const { publicUrl } = await getRuntimeConfig(db);
    const view = await getGithubAppView(db);

    // A GitHub Enterprise Server deployment has the same handshake on its own host, but this
    // path is only exercised against github.com. Refuse instead of creating an App on the
    // wrong host; the manual form below still works for GHES.
    if (!isGithubDotCom(view.apiBaseUrl)) {
      throw new AdminError(
        "manifest_requires_github_dot_com",
        409,
        "一键创建只支持 github.com。GitHub Enterprise Server 请用下面的手动填写。",
      );
    }

    const body = await readJsonBody(request);
    const owner = stringField(body, "owner", { max: 39 }).trim();
    if (owner && !OWNER_PATTERN.test(owner)) {
      throw new AdminError("invalid_owner", 400, "组织名只能是字母、数字与连字符");
    }

    const state = encodeManifestState(
      {
        adminId: auth.session.admin.id,
        nonce: randomUUID(),
        exp: Math.floor(Date.now() / 1000) + MANIFEST_STATE_TTL_SECONDS,
      },
      config.sessionSecret,
    );
    await setGithubManifestCookie(state, MANIFEST_STATE_TTL_SECONDS);

    return NextResponse.json({
      actionUrl: manifestStartUrl(webHostFor(view.apiBaseUrl), state, owner || null),
      manifest: buildGithubAppManifest({
        name: defaultAppName(publicUrl),
        publicUrl,
        webhookUrl: githubWebhookUrl(publicUrl),
        setupUrl: githubSetupUrl(publicUrl),
        redirectUrl: manifestCallbackUrl(publicUrl),
      }),
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
