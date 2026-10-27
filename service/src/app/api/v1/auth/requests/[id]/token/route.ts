import { getDb } from "@/db/client";
import { requestIp } from "@/lib/auth/http";
import { exchangeAuthRequest } from "@/lib/install-auth/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Trade an approved request for the account token — the one response that ever carries the
 * plaintext `sfo_…` value.
 *
 * Anonymous by necessity (the caller has no token yet) and one-shot by construction: the
 * consume inside `exchangeAuthRequest` only matches `status = 'approved'`, so a replay finds
 * nothing. The response is `no-store` so no proxy keeps the token.
 */
export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { id } = await context.params;

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
  if (typeof body.code_verifier !== "string") {
    return errorResponse(400, "invalid_request");
  }

  const result = await exchangeAuthRequest(getDb(), id, body.code_verifier, {
    ip: requestIp(request),
    userAgent: request.headers.get("user-agent"),
  });
  if (!result.ok) {
    return errorResponse(statusFor(result.code), result.code);
  }

  return Response.json(
    {
      access_token: result.accessToken,
      token_type: "Bearer",
      expires_in: result.expiresIn,
      expires_at: result.expiresAt.toISOString(),
      scope: result.scope,
      account: result.account,
    },
    { headers: NO_STORE },
  );
}

/**
 * 404 = nothing to exchange; 410 = it timed out; 409 = it exists but is not (or no longer)
 * approvable; 400 = the caller's PKCE half is wrong. The plugin maps these onto "reconnect"
 * vs "start over" without guessing.
 */
function statusFor(code: string): number {
  switch (code) {
    case "request_not_found":
      return 404;
    case "request_expired":
      return 410;
    case "request_already_used":
    case "request_denied":
    case "request_not_approved":
      return 409;
    default:
      return 400;
  }
}

function errorResponse(status: number, code: string): Response {
  return Response.json({ code, message: code }, { status, headers: NO_STORE });
}
