import { getDb } from "@/db/client";
import { jsonError } from "@/lib/auth/http";
import { getProductReadme } from "@/lib/products/store";
import { extractSummary } from "@/lib/readme/summary";
import {
  authorizeDashboardRequest,
  jsonOk,
  productErrorResponse,
  requireOwnedProduct,
} from "@/lib/products/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * Suggest a summary from the cached README.
 *
 * Nothing is written: the value goes into the textarea, and the developer's own "保存文案"
 * is still the only writer. That keeps the summary a human decision (the extraction is
 * seeded from the first real paragraph) while removing the "open GitHub in another tab and
 * retype a sentence" step.
 *
 * The same `MAX_SUMMARY_LENGTH` the PATCH enforces is applied here, so the suggestion can
 * never be longer than the field accepts.
 */
export async function POST(request: Request, context: Context) {
  try {
    const db = getDb();
    const auth = await authorizeDashboardRequest(db, request, { mutation: true });
    if (!auth.ok) return auth.response;

    const { id } = await context.params;
    const { product } = await requireOwnedProduct(db, id, auth.accountId);

    const readme = await getProductReadme(db, id);
    if (!readme || product.repoId === null || readme.repoId !== product.repoId) {
      return jsonError("readme_unavailable", 409);
    }

    return jsonOk({ summary: extractSummary(readme.markdown, 300) });
  } catch (error) {
    return productErrorResponse(error);
  }
}
