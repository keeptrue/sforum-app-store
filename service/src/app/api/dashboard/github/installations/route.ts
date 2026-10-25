import { getDb } from "@/db/client";
import {
  authorizeDashboardRequest,
  jsonOk,
  productErrorResponse,
} from "@/lib/products/service";
import { listAccountInstallations } from "@/lib/github/repos";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The GitHub installations this account ran, plus how many repositories each one mirrored.
 *
 * Deleted installations are omitted; a suspended one stays visible with its status so the
 * developer can tell "GitHub disabled the App" from "I never installed it".
 */
export async function GET(request: Request) {
  try {
    const db = getDb();
    const auth = await authorizeDashboardRequest(db, request, { mutation: false });
    if (!auth.ok) return auth.response;

    const installations = await listAccountInstallations(db, auth.accountId);
    return jsonOk({ installations });
  } catch (error) {
    return productErrorResponse(error);
  }
}
