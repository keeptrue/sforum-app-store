import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse, readJsonBody, stringField } from "@/lib/admin/http";
import { requestIp, requestOrigin } from "@/lib/auth/http";
import {
  clearStoreSettings,
  getStoreSettingsView,
  saveStoreSettings,
  type SaveContext,
} from "@/lib/settings/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Runtime store settings (2026-10-25).
 *
 * `PUT` is a full replacement of the three editable keys, and it answers with the *effective*
 * settings re-read after the write — the client renders what the process will actually use,
 * not what it sent. `DELETE` drops the row so every key returns to the env seed / built-in
 * default; that is the escape hatch for a value that made the console unreachable.
 */

function saveContext(request: Request): SaveContext {
  const origin = requestOrigin(request);
  return {
    requestOrigin: origin,
    requestProtocol: origin?.startsWith("http:") ? "http:" : origin ? "https:" : null,
    requestHost: origin ? new URL(origin).host : null,
  };
}

export async function GET(request: Request) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: false });
    if (!auth.ok) return auth.response;

    const origin = requestOrigin(request);
    const settings = await getStoreSettingsView(db, {
      requestHost: origin ? new URL(origin).host : null,
    });
    return NextResponse.json({ settings });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const body = await readJsonBody(request);
    const result = await saveStoreSettings(
      db,
      {
        publicUrl: stringField(body, "publicUrl", { required: true, max: 500 }),
        downloadTtlSeconds: body.downloadTtlSeconds,
        downloadMode: body.downloadMode,
        rateLimits: body.rateLimits,
        confirmOriginChange: body.confirmOriginChange === true,
        confirmInsecureTransition: body.confirmInsecureTransition === true,
      },
      { adminId: auth.session.admin.id, ip: requestIp(request) },
      saveContext(request),
    );

    return NextResponse.json({
      ok: true,
      changed: result.changed,
      settings: result.view,
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const settings = await clearStoreSettings(db, {
      adminId: auth.session.admin.id,
      ip: requestIp(request),
    });

    return NextResponse.json({ ok: true, settings });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
