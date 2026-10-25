import { getDb } from "@/db/client";
import { ConfigError, getConfig } from "@/lib/config";
import { getRuntimeConfig } from "@/lib/settings/runtime";
import { issueDownloadUrl } from "@/lib/download/issue";
import { enforceChannelLimit, ipBucket } from "@/lib/ratelimit/enforce";

export const runtime = "nodejs";

// Issuing is anonymous: no session, no cookie. The URL itself is the only credential.
const NO_STORE = { "Cache-Control": "private, no-store" };

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
    const limited = await enforceChannelLimit(db, "download-ip", ipBucket(request, "download-ip"));
    if (limited) return limited;

    const config = getConfig();
    const runtime = await getRuntimeConfig(db);
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
