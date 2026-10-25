import { getDb } from "@/db/client";
import {
  CATALOG_CACHE_CONTROL,
  etagForJson,
  ifNoneMatchMatches,
  listProductReleases,
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
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    const { slug } = await context.params;
    const channelParam = new URL(request.url).searchParams.get("channel");
    const channel = channelParam === null || channelParam.trim() === ""
      ? null
      : channelParam.trim();
    if (channel !== null && channel !== "stable" && channel !== "beta") {
      return errorResponse("invalid_query", 400, "query parameters are not acceptable");
    }

    const releases = await listProductReleases(getDb(), slug, { channel });
    if (releases === null) {
      return errorResponse("not_found", 404, "product not found");
    }

    const etag = etagForJson(releases, JSON.stringify([channel]));
    const header = `"${etag}"`;
    if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: header, "Cache-Control": CATALOG_CACHE_CONTROL },
      });
    }

    return Response.json(releases, {
      headers: { ETag: header, "Cache-Control": CATALOG_CACHE_CONTROL },
    });
  } catch (error) {
    console.error("[catalog] unexpected error", error);
    return errorResponse("internal_error", 500, "internal error");
  }
}
