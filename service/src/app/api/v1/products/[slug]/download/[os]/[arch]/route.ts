import { getDb } from "@/db/client";
import { readSessionCookie } from "@/lib/auth/cookies";
import { findSession } from "@/lib/auth/service";
import { ConfigError, getConfig } from "@/lib/config";
import { getRuntimeConfig } from "@/lib/settings/runtime";
import { issueDownloadUrl } from "@/lib/download/issue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

type RouteContext = {
  params: Promise<{ slug: string; os: string; arch: string }>;
};

/**
 * Browser entry point: same issuer as `POST /api/v1/download-urls`, answered as a 302 so a
 * plain anchor click downloads without the frontend building a URL by hand.
 *
 * When `download_auth_mode` is `account_required` this route is a session gate: no store
 * session means a 302 into the forum login with this exact path as the return address, and the
 * login callback lands back here, where the session is now present. The signed URL is still a
 * 30-minute bearer — the gate is on *getting* the link, not on the bytes.
 */
export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { slug, os, arch } = await context.params;

  try {
    const config = getConfig();
    const db = getDb();
    const runtime = await getRuntimeConfig(db);

    if (runtime.downloadAuthMode === "account_required") {
      const token = await readSessionCookie();
      const session = token ? await findSession(db, token) : null;
      if (!session) {
        const path = new URL(request.url).pathname + new URL(request.url).search;
        const login = new URL("/api/auth/sforum/start", runtime.publicUrl);
        login.searchParams.set("redirect", path);
        return new Response(null, {
          status: 302,
          headers: { ...NO_STORE, Location: login.toString() },
        });
      }
    }

    const result = await issueDownloadUrl(
      db,
      { product: slug, version: null, os, arch },
      {
        secret: config.downloadSecret,
        publicUrl: runtime.publicUrl,
        ttlSeconds: runtime.downloadTtlSeconds,
      },
    );
    if (!result.ok) return errorResponse(result.status, result.code);

    return new Response(null, {
      status: 302,
      headers: { ...NO_STORE, Location: result.body.url },
    });
  } catch (error) {
    if (error instanceof ConfigError) return errorResponse(500, "config_error");
    console.error("[product-download] unexpected error", error);
    return errorResponse(500, "internal_error");
  }
}

function errorResponse(status: number, code: string): Response {
  return Response.json({ code, message: code }, { status, headers: NO_STORE });
}
