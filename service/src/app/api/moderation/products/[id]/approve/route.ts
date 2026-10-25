import { getDb } from "@/db/client";
import { requestIp } from "@/lib/auth/http";
import { approveProduct, authorizeModerationRequest } from "@/lib/moderation/service";
import { jsonOk, productErrorResponse } from "@/lib/products/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const db = getDb();
    const auth = await authorizeModerationRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const { id } = await context.params;
    const product = await approveProduct(db, {
      accountId: auth.accountId,
      productId: id,
      ip: requestIp(request),
    });
    return jsonOk({ product });
  } catch (error) {
    return productErrorResponse(error);
  }
}
