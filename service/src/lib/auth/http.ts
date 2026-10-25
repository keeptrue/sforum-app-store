import { ConfigError } from "@/lib/config";
import { OAuthError } from "@/lib/oauth/provider";

export function jsonError(
  code: string,
  status: number,
  message?: string,
): Response {
  return Response.json(
    { code, message: message ?? code },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export function routeError(error: unknown): Response {
  if (error instanceof ConfigError) {
    return jsonError("config_error", 500, error.message);
  }
  if (error instanceof OAuthError) {
    return jsonError(error.code, 502, error.detail);
  }
  console.error("[auth] unexpected error", error);
  return jsonError("internal_error", 500);
}

type HeaderLike = { get(name: string): string | null };

/**
 * Origin this request actually arrived on, from the transport headers rather than
 * `request.url` (which reflects whatever host the server thinks it is behind).
 *
 * `x-forwarded-*` wins: behind a proxy that is the address the browser used, and it is the one
 * a redirect or a cookie has to match. Used by the CSRF gate and by 系统设置 to compare the
 * address in the bar with the address the service believes it lives on.
 */
export function originFromHeaders(
  headers: HeaderLike,
  fallbackProtocol = "https",
): string | null {
  const host =
    headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    headers.get("host")?.trim();
  if (!host) return null;
  const proto =
    headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || fallbackProtocol;
  return `${proto.replace(/:$/, "")}://${host}`;
}

export function requestOrigin(request: Request): string | null {
  return originFromHeaders(
    request.headers,
    new URL(request.url).protocol.replace(":", ""),
  );
}

/**
 * CSRF gate for mutations: the browser's `Origin` must be an origin this deployment answers
 * on.
 *
 * Two acceptable answers, and the second one is what keeps the console usable:
 * - the configured public URL — the address visitors are *supposed* to use;
 * - the request's own origin — where this request actually arrived. A browser cannot forge
 *   `Origin`, so this is the standard check, and it means an operator who just changed the
 *   public URL (or is testing before the proxy is ready) is not locked out of the very page
 *   that would fix it.
 */
export function isSameOrigin(
  request: Request,
  allowedPublicUrl: string | string[],
): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const actual = new URL(origin).origin;
    const configured = (Array.isArray(allowedPublicUrl) ? allowedPublicUrl : [allowedPublicUrl])
      .filter(Boolean)
      .map((value) => {
        try {
          return new URL(value).origin;
        } catch {
          return null;
        }
      });
    if (configured.includes(actual)) return true;
    if (requestOrigin(request) === actual) return true;

    // The caller only ever sees a bare `origin_mismatch`, which cannot distinguish "the proxy
    // rewrote Origin" from "the public URL was never updated for this deployment". Log both
    // sides once per rejection — neither value is a secret, both are in the request already.
    console.warn("[auth] rejected a cross-origin mutation", {
      expected: configured[0] ?? null,
      requestOrigin: requestOrigin(request),
      actual,
    });
    return false;
  } catch {
    return false;
  }
}

export function requestIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null;
  return request.headers.get("x-real-ip");
}

export function safeRedirect(value: string | null): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export function errorRedirect(publicUrl: string, code: string): URL {
  const url = new URL("/", publicUrl);
  url.searchParams.set("auth_error", code);
  return url;
}

/** 429 with the retry window; never leaks the counter or the bucket key. */
export function rateLimitedResponse(retryAfterSeconds: number): Response {
  return Response.json(
    { code: "rate_limited", message: "too many requests" },
    {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(retryAfterSeconds),
      },
    },
  );
}
