import { getDb } from "@/db/client";
import {
  CATALOG_CACHE_CONTROL,
  etagForJson,
  getProductRelease,
  ifNoneMatchMatches,
} from "@/lib/catalog/query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(code: string, status: number, message: string): Response {
  return Response.json(
    { code, message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string; version: string }> },
): Promise<Response> {
  try {
    const { slug, version } = await context.params;

    const release = await getProductRelease(getDb(), slug, version);
    if (release === null) {
      return errorResponse("not_found", 404, "release not found");
    }

    const etag = etagForJson(release);
    const header = `"${etag}"`;
    if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: header, "Cache-Control": CATALOG_CACHE_CONTROL },
      });
    }

    return Response.json(release, {
      headers: { ETag: header, "Cache-Control": CATALOG_CACHE_CONTROL },
    });
  } catch (error) {
    console.error("[catalog] unexpected error", error);
    return errorResponse("internal_error", 500, "internal error");
  }
}
