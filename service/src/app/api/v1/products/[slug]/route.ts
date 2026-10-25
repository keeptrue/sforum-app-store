import { getDb } from "@/db/client";
import {
  CATALOG_CACHE_CONTROL,
  etagForJson,
  ifNoneMatchMatches,
  loadProductDetail,
} from "@/lib/catalog/query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(code: string, status: number, message: string): Response {
  return Response.json(
    { code, message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function cleaned(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    const { slug } = await context.params;
    const searchParams = new URL(request.url).searchParams;
    const sforum = cleaned(searchParams.get("sforum"));
    const sforumBuild = cleaned(searchParams.get("sforumBuild"));

    const detail = await loadProductDetail(getDb(), slug, { sforum, sforumBuild });
    if (detail === null) {
      return errorResponse("not_found", 404, "product not found");
    }

    const etag = etagForJson(detail, JSON.stringify([sforum, sforumBuild]));
    const header = `"${etag}"`;
    if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: header, "Cache-Control": CATALOG_CACHE_CONTROL },
      });
    }

    return Response.json(detail, {
      headers: { ETag: header, "Cache-Control": CATALOG_CACHE_CONTROL },
    });
  } catch (error) {
    console.error("[catalog] unexpected error", error);
    return errorResponse("internal_error", 500, "internal error");
  }
}
