import { getDb } from "@/db/client";
import { jsonError } from "@/lib/auth/http";
import {
  authorizeDashboardRequest,
  delistProduct,
  getDashboardProduct,
  jsonOk,
  parseProductPatch,
  patchProduct,
  productErrorResponse,
} from "@/lib/products/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const db = getDb();
    const auth = await authorizeDashboardRequest(db, request, {
      mutation: false,
    });
    if (!auth.ok) return auth.response;

    const { id } = await context.params;
    const product = await getDashboardProduct(db, {
      accountId: auth.accountId,
      productId: id,
    });
    return jsonOk({ product });
  } catch (error) {
    return productErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const db = getDb();
    const auth = await authorizeDashboardRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const body = await request.json().catch(() => undefined);
    if (body === undefined) return jsonError("invalid_json", 400);

    const { id } = await context.params;
    const patch = parseProductPatch(body);
    const product = await patchProduct(db, {
      accountId: auth.accountId,
      productId: id,
      patch,
    });
    return jsonOk({ product });
  } catch (error) {
    return productErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const db = getDb();
    const auth = await authorizeDashboardRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const { id } = await context.params;
    await delistProduct(db, { accountId: auth.accountId, productId: id });
    return jsonOk({ ok: true, status: "delisted" });
  } catch (error) {
    return productErrorResponse(error);
  }
}
