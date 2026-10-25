import { getDb } from "@/db/client";
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
 */
export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const { slug, os, arch } = await context.params;

  try {
    const config = getConfig();
    const db = getDb();
    const runtime = await getRuntimeConfig(db);
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
