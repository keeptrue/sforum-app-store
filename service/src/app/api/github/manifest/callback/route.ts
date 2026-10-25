import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { AdminError } from "@/lib/admin/errors";
import { getAdminSession } from "@/lib/admin/guard";
import { clearGithubManifestCookie, readGithubManifestCookie } from "@/lib/auth/cookies";
import { requestIp } from "@/lib/auth/http";
import { getConfig } from "@/lib/config";
import {
  exchangeManifestCode,
  GITHUB_DOT_COM_API,
  verifyManifestState,
} from "@/lib/github/manifest";
import { replaceGithubAppFromManifest, verifyGithubApp } from "@/lib/github/app-config";
import { getRuntimeConfig } from "@/lib/settings/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Step 3 of the manifest handshake: GitHub sends the browser back here with a temporary
 * `code`, and we exchange it for the App's id, slug, private key and webhook secret.
 *
 * Three things make this safe to expose without a session check up front:
 *
 * 1. `POST /app-manifests/{code}/conversions` is unauthenticated — the code is the credential.
 *    What it must not be able to do is write into *our* console, so the state cookie is
 *    required, signed, unexpired, and bound to the admin id that started the flow.
 * 2. The session cookie is `SameSite=Lax`, so a top-level GET back from github.com carries it
 *    and `getAdminSession` can prove the same person is still logged in.
 * 3. The code is single use, so a replayed callback dies at GitHub rather than double-writing.
 *
 * Failures redirect with a reason code instead of answering JSON: the person is looking at a
 * browser tab, not at curl.
 */
export async function GET(request: Request) {
  const db = getDb();
  const config = getConfig();
  const { publicUrl } = await getRuntimeConfig(db);
  const back = (params: Record<string, string>) => {
    const url = new URL(`/${config.adminPath}/settings/github`, publicUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return NextResponse.redirect(url, 303);
  };

  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (!code || !state) return back({ manifest: "failed", reason: "missing_params" });

    const cookie = await readGithubManifestCookie();
    const payload = verifyManifestState(cookie, state, config.sessionSecret);
    if (!payload) return back({ manifest: "failed", reason: "state" });

    // The state names an admin; the session proves it is still that admin's browser. Without
    // this a leaked callback URL would let any logged-in admin install someone else's App.
    const session = await getAdminSession(db);
    if (!session || session.admin.id !== payload.adminId) {
      return back({ manifest: "failed", reason: "session" });
    }

    const actor = { adminId: session.admin.id, ip: requestIp(request) };
    const conversion = await exchangeManifestCode({ apiBaseUrl: GITHUB_DOT_COM_API, code });

    const { replacedAppId } = await replaceGithubAppFromManifest(
      db,
      config,
      {
        appId: conversion.appId,
        slug: conversion.slug,
        webhookSecret: conversion.webhookSecret,
        privateKeyPem: conversion.pem,
      },
      actor,
    );

    await clearGithubManifestCookie();

    // Best effort: the console should land on "已连通" rather than on an unverified App. A
    // failure is recorded on the row and shown by the page, so it must not lose the redirect.
    let verified = false;
    try {
      const result = await verifyGithubApp(db, actor);
      verified = result.ok;
    } catch (error) {
      console.error("[github] manifest verify failed", error);
    }

    return back({
      manifest: "created",
      slug: conversion.slug,
      appId: String(conversion.appId),
      verified: verified ? "1" : "0",
      ...(replacedAppId ? { replaced: String(replacedAppId) } : {}),
    });
  } catch (error) {
    if (error instanceof AdminError) {
      console.error("[github] manifest callback rejected", error.code, error.message);
      return back({ manifest: "failed", reason: error.code });
    }
    console.error("[github] manifest callback failed", error);
    return back({ manifest: "failed", reason: "internal" });
  }
}
