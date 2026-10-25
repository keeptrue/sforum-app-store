import { getDb } from "@/db/client";
import { ConfigError, getConfig } from "@/lib/config";
import { resolveDownloadTarget } from "@/lib/download/resolve";
import { verifyDownloadToken } from "@/lib/download/token";
import { sha256Hex } from "@/lib/crypto";
import { getRuntimeConfig } from "@/lib/settings/runtime";
import { enforceChannelLimit, ipBucket } from "@/lib/ratelimit/enforce";
import {
  fetchUpstreamRedirect,
  fetchUpstreamZip,
  GithubNotConfiguredError,
} from "@/lib/download/upstream";
import { GithubAppConfigError } from "@/lib/github/app-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = "private, no-store";

type RouteContext = { params: Promise<{ token: string }> };

/**
 * Signed download proxy.
 *
 * The ZIP body is forwarded untouched: no buffering, no re-hashing. "Digest matches" is a
 * token↔DB statement (Q5) — the token's sha256 must equal the digest on the asset row — not a
 * promise that the bytes were verified on the way out. Verifying 50 MiB mid-stream would mean
 * buffering them, which the store explicitly does not do.
 */
export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { token } = await context.params;

  let config;
  try {
    config = getConfig();
  } catch (error) {
    return failure(error);
  }

  const verified = verifyDownloadToken(token, config.downloadSecret);
  if (!verified.ok) return errorResponse(410, verified.code);

  // Two counters: one per client (a script hammering the endpoint) and one per token (a
  // leaked link being shared). The bucket stores a hash, never the token itself.
  const db = getDb();
  // Console-editable since 2026-10-25 (`store_settings.download_mode`), seeded by
  // `STORE_DOWNLOAD_MODE`. Same cached read the limiter below already performs.
  const runtime = await getRuntimeConfig(db);
  const ipLimited = await enforceChannelLimit(
    db,
    "download-ip",
    ipBucket(request, "download-ip"),
  );
  if (ipLimited) return ipLimited;
  const tokenLimited = await enforceChannelLimit(
    db,
    "download-token",
    `download-token:token:${sha256Hex(token).slice(0, 32)}`,
  );
  if (tokenLimited) return tokenLimited;

  let resolved;
  try {
    resolved = await resolveDownloadTarget(db, verified.claims);
  } catch (error) {
    return failure(error);
  }
  if (!resolved.ok) return errorResponse(resolved.status, resolved.code);

  const target = resolved.target;

  // Redirect mode: hand the client the signed object URL instead of carrying the bytes. The
  // five checks above still ran, so a yank or a disconnect is refused here — but a link that
  // was already answered cannot be revoked, which is the price of not being the carrier.
  // Private repositories keep the proxy: their object URL names the repository and the tag.
  if (runtime.downloadMode === "redirect" && !target.repoPrivate) {
    let location: string | null;
    try {
      location = await fetchUpstreamRedirect(target);
    } catch (error) {
      if (error instanceof GithubNotConfiguredError) {
        return errorResponse(503, "github_not_configured");
      }
      if (error instanceof GithubAppConfigError) {
        return errorResponse(503, error.code);
      }
      console.error("[download] upstream redirect failed", error);
      return errorResponse(503, "upstream_unavailable");
    }
    if (location) {
      return new Response(null, {
        status: 302,
        headers: {
          "Cache-Control": NO_STORE,
          Location: location,
          // The token is in the request path; never echo it to the object host's logs.
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    // GitHub streamed the asset itself instead of redirecting (the API allows both), so
    // there is no address to hand out. Fall through to the proxy rather than 500.
  }

  let upstream: Response;
  try {
    upstream = await fetchUpstreamZip(target);
  } catch (error) {
    if (error instanceof GithubNotConfiguredError) {
      return errorResponse(503, "github_not_configured");
    }
    // Stored but unreadable (keyring kid missing) or keyless: 503 with the reason, not a 500.
    if (error instanceof GithubAppConfigError) {
      return errorResponse(503, error.code);
    }
    console.error("[download] upstream fetch failed", error);
    return errorResponse(503, "upstream_unavailable");
  }

  if (!upstream.ok || !upstream.body) {
    // Drain nothing: a failed upstream response is discarded whole. The client sees 503 and
    // the plugin maps it to `download_failed`, which the administrator can retry.
    return errorResponse(503, "upstream_unavailable");
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(target.size),
      "Content-Disposition": contentDisposition(target.filename),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": NO_STORE,
    },
  });
}

/**
 * Build `attachment; filename="..."` from an untrusted asset name.
 *
 * Quotes are stripped (they would end the quoted-string early), CR/LF are stripped (header
 * injection), backslashes are doubled, and anything outside printable ASCII becomes `_`:
 * Bun throws on non-ASCII header values, so a CJK asset name would otherwise turn a valid
 * download into a 500. The length cap keeps a pathological name from bloating the header.
 */
function contentDisposition(filename: string): string {
  const safe = filename
    .replace(/[\r\n]/g, "")
    .replace(/"/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/[^\x20-\x7e]/g, "_")
    .slice(0, 200);
  return `attachment; filename="${safe}"`;
}

function errorResponse(status: number, code: string): Response {
  return Response.json(
    { code, message: code },
    { status, headers: { "Cache-Control": NO_STORE } },
  );
}

function failure(error: unknown): Response {
  if (error instanceof ConfigError) return errorResponse(500, "config_error");
  console.error("[download] unexpected error", error);
  return errorResponse(500, "internal_error");
}
