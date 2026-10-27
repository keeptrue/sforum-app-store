import { getDb } from "@/db/client";
import { requestIp } from "@/lib/auth/http";
import { createAuthRequest } from "@/lib/install-auth/service";
import { getRuntimeConfig } from "@/lib/settings/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * Open one "connect store" request.
 *
 * Anonymous: the caller is a plugin backend that has no credential yet — the credential is
 * what this flow produces. Abuse is bounded by the `install-auth-start` rate-limit channel and
 * by the 5-minute request TTL, not by authentication.
 */
export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, "invalid_request");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return errorResponse(400, "invalid_request");
  }
  const body = payload as Record<string, unknown>;
  if (typeof body.code_challenge !== "string") {
    return errorResponse(400, "invalid_request");
  }
  if (
    body.client_label !== undefined &&
    body.client_label !== null &&
    typeof body.client_label !== "string"
  ) {
    return errorResponse(400, "invalid_request");
  }

  const db = getDb();
  const runtime = await getRuntimeConfig(db);
  const result = await createAuthRequest(db, {
    codeChallenge: body.code_challenge,
    clientLabel: typeof body.client_label === "string" ? body.client_label : null,
    ip: requestIp(request),
    userAgent: request.headers.get("user-agent"),
    publicUrl: runtime.publicUrl,
  });
  if (!result.ok) {
    return result.code === "issuer_unavailable"
      ? errorResponse(503, result.code)
      : errorResponse(400, result.code);
  }
  return Response.json(
    {
      id: result.id,
      authorize_url: result.authorizeUrl,
      expires_in: result.expiresIn,
      interval: result.interval,
    },
    { headers: NO_STORE },
  );
}

function errorResponse(status: number, code: string): Response {
  return Response.json({ code, message: code }, { status, headers: NO_STORE });
}
