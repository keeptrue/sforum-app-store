import { getDb } from "@/db/client";
import { loadModerationQueue } from "@/lib/moderation/queue";
import { authorizeModerationRequest } from "@/lib/moderation/service";
import { jsonOk, productErrorResponse } from "@/lib/products/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const db = getDb();
    const auth = await authorizeModerationRequest(db, request, {
      mutation: false,
    });
    if (!auth.ok) return auth.response;

    return jsonOk({ queue: await loadModerationQueue(db) });
  } catch (error) {
    return productErrorResponse(error);
  }
}
