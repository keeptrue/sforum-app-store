import { getDb } from "@/db/client";
import {
  CATALOG_CACHE_CONTROL,
  ifNoneMatchMatches,
  listCatalog,
  parseCatalogQuery,
} from "@/lib/catalog/query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(code: string, status: number, message: string): Response {
  return Response.json(
    { code, message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request): Promise<Response> {
  try {
    const parsed = parseCatalogQuery(new URL(request.url).searchParams);
    if (!parsed.ok) {
      const message =
        parsed.code === "invalid_cursor"
          ? "pagination cursor is not readable"
          : "query parameters are not acceptable";
      return errorResponse(parsed.code, 400, message);
    }

    const { body, etag } = await listCatalog(getDb(), parsed.query);
    const header = `"${etag}"`;
    if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: header, "Cache-Control": CATALOG_CACHE_CONTROL },
      });
    }

    return Response.json(body, {
      headers: { ETag: header, "Cache-Control": CATALOG_CACHE_CONTROL },
    });
  } catch (error) {
    console.error("[catalog] unexpected error", error);
    return errorResponse("internal_error", 500, "internal error");
  }
}
