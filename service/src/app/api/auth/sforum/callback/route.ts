import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import {
  clearStateCookie,
  readStateCookie,
  setSessionCookie,
} from "@/lib/auth/cookies";
import { errorRedirect, requestIp, routeError } from "@/lib/auth/http";
import { completeLogin } from "@/lib/auth/service";
import { decodeState } from "@/lib/auth/state";
import { getConfig } from "@/lib/config";
import { getRuntimeConfig } from "@/lib/settings/runtime";
import { enforceChannelLimit, ipBucket } from "@/lib/ratelimit/enforce";
import { recordAudit } from "@/lib/moderation/events";
import { OAuthError } from "@/lib/oauth/provider";

/**
 * 认证审计：成功与失败都进同一条时间线，但审计写入失败绝不阻断登录
 * （审计是证据，不是闸门）。
 */
async function auditLogin(
  outcome: "succeeded" | "failed",
  input: {
    reason?: string;
    accountId?: string | null;
    ip?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await recordAudit(getDb(), {
      actorAccountId: input.accountId ?? null,
      action: `auth.login.${outcome}`,
      targetType: "account",
      targetId: input.accountId ?? null,
      details: { reason: input.reason ?? null, ...(input.details ?? {}) },
      ip: input.ip ?? null,
    });
  } catch (error) {
    console.warn("[auth] failed to write login audit", {
      outcome,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  let publicUrl = "";
  try {
    const config = getConfig();
    publicUrl = (await getRuntimeConfig(getDb())).publicUrl;
    const url = new URL(request.url);

    const providerError = url.searchParams.get("error");
    if (providerError) {
      await auditLogin("failed", {
        reason: `provider_${providerError}`,
        ip: requestIp(request),
      });
      await clearStateCookie();
      return NextResponse.redirect(
        errorRedirect(publicUrl, `provider_${providerError}`),
        303,
      );
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      await auditLogin("failed", { reason: "missing_code_or_state", ip: requestIp(request) });
      return NextResponse.redirect(
        errorRedirect(publicUrl, "missing_code_or_state"),
        303,
      );
    }

    const cookie = await readStateCookie();
    const payload = cookie ? decodeState(cookie, config.sessionSecret) : null;
    if (!payload || payload.state !== state) {
      await auditLogin("failed", { reason: "state_mismatch", ip: requestIp(request) });
      await clearStateCookie();
      return NextResponse.redirect(
        errorRedirect(publicUrl, "state_mismatch"),
        303,
      );
    }

    await clearStateCookie();
    const result = await completeLogin({
      db: getDb(),
      config,
      issuerKey: payload.issuerKey,
      code,
      verifier: payload.verifier,
      redirectUri: `${publicUrl}/api/auth/sforum/callback`,
      userAgent: request.headers.get("user-agent"),
      ip: requestIp(request),
    });
    await setSessionCookie(result.sessionToken, result.expiresAt);
    await auditLogin("succeeded", {
      accountId: result.account.id,
      ip: requestIp(request),
      details: { issuerKey: result.account.issuerKey, roles: result.roles },
    });

    return NextResponse.redirect(
      new URL(payload.redirectTo, publicUrl),
      303,
    );
  } catch (error) {
    if (error instanceof OAuthError) {
      await auditLogin("failed", {
        reason: error.code,
        ip: requestIp(request),
      });
      return NextResponse.redirect(
        errorRedirect(publicUrl || "http://127.0.0.1:4000", error.code),
        303,
      );
    }
    return routeError(error);
  }
}
