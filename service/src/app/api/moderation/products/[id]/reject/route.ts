import { getDb } from "@/db/client";
import { jsonError, requestIp } from "@/lib/auth/http";
import { authorizeModerationRequest, rejectProduct } from "@/lib/moderation/service";
import { jsonOk, productErrorResponse } from "@/lib/products/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const db = getDb();
    const auth = await authorizeModerationRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const body = (await request.json().catch(() => undefined)) as
      | { reason?: unknown }
      | undefined;
    if (body === undefined) return jsonError("invalid_json", 400);

    const { id } = await context.params;
    const product = await rejectProduct(db, {
      accountId: auth.accountId,
      productId: id,
      reason: body.reason,
      ip: requestIp(request),
    });
    return jsonOk({ product });
  } catch (error) {
    return productErrorResponse(error);
  }
}
