import { getDb } from "@/db/client";
import { requestIp } from "@/lib/auth/http";
import {
  authorizeDashboardRequest,
  jsonOk,
  productErrorResponse,
  submitProductForReview,
} from "@/lib/products/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const db = getDb();
    const auth = await authorizeDashboardRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const { id } = await context.params;
    const product = await submitProductForReview(db, {
      accountId: auth.accountId,
      productId: id,
      ip: requestIp(request),
    });
    return jsonOk({ product });
  } catch (error) {
    return productErrorResponse(error);
  }
}
