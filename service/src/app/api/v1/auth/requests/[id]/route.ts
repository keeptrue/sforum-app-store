import { getDb } from "@/db/client";
import { readAuthRequestStatus } from "@/lib/install-auth/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Polling endpoint. Returns the status and nothing else: no account, no label, no timestamps.
 * A request id is a bearer-ish value for this one question, so the answer must not leak who
 * approved it.
 */
export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const { id } = await context.params;
  const status = await readAuthRequestStatus(getDb(), id);
  if (!status) {
    return Response.json(
      { code: "request_not_found", message: "request_not_found" },
      { status: 404, headers: NO_STORE },
    );
  }
  return Response.json({ status }, { headers: NO_STORE });
}
