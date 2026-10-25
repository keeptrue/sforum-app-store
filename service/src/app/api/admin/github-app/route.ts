import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse, readJsonBody, stringField } from "@/lib/admin/http";
import { requestIp } from "@/lib/auth/http";
import { getConfig } from "@/lib/config";
import {
  clearGithubAppConfig,
  getGithubAppView,
  saveGithubAppConfig,
} from "@/lib/github/app-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The console read model: booleans and fingerprints, never a secret. */
export async function GET(request: Request) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: false });
    if (!auth.ok) return auth.response;

    return NextResponse.json({ app: await getGithubAppView(db) });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

/**
 * Create on first save, update afterwards. `webhookSecret` and `privateKeyPem` are
 * write-only: an empty or omitted value means "keep what is stored", and the domain layer
 * turns that into `missing_webhook_secret` / `missing_private_key` on the first save.
 */
export async function PUT(request: Request) {
  try {
    const db = getDb();
    const config = getConfig();
    const auth = await authorizeAdminRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const body = await readJsonBody(request);
    // A number or a numeric string: the domain validator owns the shape check, and its
    // messages ("app_id 必须是正整数…", "slug 是 App 的 URL 名…") are the ones worth showing.
    const appId =
      typeof body.appId === "number" ? body.appId : stringField(body, "appId", { max: 32 });

    const result = await saveGithubAppConfig(
      db,
      config,
      {
        appId,
        slug: stringField(body, "slug", { max: 64 }),
        apiBaseUrl: stringField(body, "apiBaseUrl", { max: 500 }),
        webhookSecret: stringField(body, "webhookSecret", { max: 256 }) || undefined,
        privateKeyPem: stringField(body, "privateKeyPem", { max: 16384 }) || undefined,
      },
      { adminId: auth.session.admin.id, ip: requestIp(request) },
    );

    return NextResponse.json({ ok: true, addedKey: result.addedKey });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

/** Removes the App; installations and synced repositories are history and stay. */
export async function DELETE(request: Request) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    await clearGithubAppConfig(db, {
      adminId: auth.session.admin.id,
      ip: requestIp(request),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
