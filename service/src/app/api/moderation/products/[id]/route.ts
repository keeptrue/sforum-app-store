import { getDb } from "@/db/client";
import { jsonError } from "@/lib/auth/http";
import { loadModerationProductDetail } from "@/lib/moderation/queue";
import { authorizeModerationRequest } from "@/lib/moderation/service";
import { jsonOk, productErrorResponse } from "@/lib/products/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const db = getDb();
    const auth = await authorizeModerationRequest(db, request, {
      mutation: false,
    });
    if (!auth.ok) return auth.response;

    const { id } = await context.params;
    const detail = await loadModerationProductDetail(db, id);
    if (!detail) return jsonError("product_not_found", 404);

    return jsonOk({ detail });
  } catch (error) {
    return productErrorResponse(error);
  }
}
