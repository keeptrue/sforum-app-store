import { getDb } from "@/db/client";
import { jsonError, requestIp } from "@/lib/auth/http";
import { bindProductRepo, unbindProductRepo } from "@/lib/products/binding";
import {
  authorizeDashboardRequest,
  jsonOk,
  productErrorResponse,
} from "@/lib/products/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * Bind or re-bind the product's repository.
 *
 * `repo_id` is deliberately not editable through `PATCH /api/dashboard/products/[id]`
 * (`NON_EDITABLE_FIELDS`), so this endpoint is the only way a binding moves — and it writes
 * an audit row every time.
 */
export async function POST(request: Request, context: Context) {
  try {
    const db = getDb();
    const auth = await authorizeDashboardRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const body = (await request.json().catch(() => undefined)) as
      | { repoId?: unknown }
      | undefined;
    if (!body) return jsonError("invalid_json", 400);

    const repoId = Number(body.repoId);
    if (!Number.isSafeInteger(repoId) || repoId <= 0) {
      return jsonError("invalid_repo_id", 400);
    }

    const { id } = await context.params;
    const product = await bindProductRepo(db, {
      accountId: auth.accountId,
      productId: id,
      repoId,
      ip: requestIp(request),
    });
    return jsonOk({ product });
  } catch (error) {
    return productErrorResponse(error);
  }
}

/** Unbind. A published product keeps its repository — unbinding it is a 409. */
export async function DELETE(request: Request, context: Context) {
  try {
    const db = getDb();
    const auth = await authorizeDashboardRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const { id } = await context.params;
    const product = await unbindProductRepo(db, {
      accountId: auth.accountId,
      productId: id,
      ip: requestIp(request),
    });
    return jsonOk({ product });
  } catch (error) {
    return productErrorResponse(error);
  }
}
