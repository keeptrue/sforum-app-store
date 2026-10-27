import { getDb } from "@/db/client";
import { ConfigError, getConfig } from "@/lib/config";
import { getRuntimeConfig } from "@/lib/settings/runtime";
import { issueDownloadUrl } from "@/lib/download/issue";
import {
  authenticateAccountToken,
  readBearerToken,
} from "@/lib/install-auth/service";
import { recordAudit } from "@/lib/moderation/events";
import { enforceChannelLimit, ipBucket } from "@/lib/ratelimit/enforce";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * Mint a signed download URL for one platform asset.
 *
 * Two modes, decided by `download_auth_mode` (runtime setting, default `anonymous`):
 *
 * - `anonymous` — today's behaviour: published means installable, and a token that happens to
 *   be present is validated for the audit trail but never required. An invalid token is
 *   ignored rather than rejected, so a forum that upgraded its plugin while the store is still
 *   anonymous never sees a spurious 401.
 * - `account_required` — a valid account token is mandatory. The failure codes are the same
 *   five the plugin already maps onto "reconnect" vs "not connected yet".
 */
export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, "invalid_body");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return errorResponse(400, "invalid_body");
  }

  const body = payload as Record<string, unknown>;
  const { product, os, arch, version } = body;
  if (
    typeof product !== "string" ||
    typeof os !== "string" ||
    typeof arch !== "string"
  ) {
    return errorResponse(400, "invalid_body");
  }
  if (version !== undefined && version !== null && typeof version !== "string") {
    return errorResponse(400, "invalid_body");
  }

  try {
    const db = getDb();
    const runtime = await getRuntimeConfig(db);

    // IP limit first: it is the only brake an anonymous caller cannot dodge.
    const limited = await enforceChannelLimit(db, "download-ip", ipBucket(request, "download-ip"));
    if (limited) return limited;

    const bearer = readBearerToken(request);
    const auth = await authenticateAccountToken(db, bearer);
    if (runtime.downloadAuthMode === "account_required" && !auth.ok) {
      return errorResponse(401, auth.code);
    }

    if (auth.ok) {
      const accountLimited = await enforceChannelLimit(
        db,
        "download-account",
        `download-account:account:${auth.account.id}`,
      );
      if (accountLimited) return accountLimited;
    }

    const config = getConfig();
    const result = await issueDownloadUrl(
      db,
      {
        product,
        version: typeof version === "string" ? version : null,
        os,
        arch,
      },
      {
        secret: config.downloadSecret,
        publicUrl: runtime.publicUrl,
        ttlSeconds: runtime.downloadTtlSeconds,
      },
    );
    if (!result.ok) return errorResponse(result.status, result.code);

    // Only account-authenticated issuance is audited: an anonymous download has no actor, and
    // writing a row per install would turn the audit trail into a rate-limited access log.
    // The signature itself is never recorded — it is a bearer credential.
    if (auth.ok) {
      await recordAudit(db, {
        actorAccountId: auth.account.id,
        action: "download.issued",
        targetType: "product",
        targetId: result.productId,
        details: {
          version: result.version,
          versionId: result.versionId,
          os,
          arch,
          mode: runtime.downloadAuthMode,
          scope: auth.token.scope,
        },
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      });
    }

    return Response.json(result.body, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ConfigError) return errorResponse(500, "config_error");
    console.error("[download-urls] unexpected error", error);
    return errorResponse(500, "internal_error");
  }
}

function errorResponse(status: number, code: string): Response {
  return Response.json({ code, message: code }, { status, headers: NO_STORE });
}
