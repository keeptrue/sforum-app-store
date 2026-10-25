import { and, eq, ne, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { oauthIssuers } from "@/db/schema";
import { AdminError } from "@/lib/admin/errors";
import type { StoreConfig } from "@/lib/config";
import { encryptSecret } from "@/lib/crypto";
import { recordAudit } from "@/lib/moderation/events";

/**
 * OAuth2 provider configuration, written from the console instead of env.
 *
 * Storage is unchanged: `client_secret_ciphertext` + `client_secret_kid` already existed and
 * the keyring is the same one that protects forum tokens. The only new thing is the writer.
 *
 * One deployment serves one forum (`decisions/2026-10-24-app-store-identity-and-distribution.md`
 * §身份): at most one issuer may be `active` at a time. The invariant is enforced three times
 * on purpose — a partial unique index in Postgres, the checks below, and the console UI — so a
 * concurrent request or a hand-written row cannot produce a store with two login sources.
 */

export const ACTIVE_ISSUER_LIMIT = 1;

/**
 * Postgres unique-violation, raised by `oauth_issuers_single_active_idx` on a race.
 * Drizzle wraps driver errors in `DrizzleQueryError`, so the SQLSTATE lives on the cause.
 */
function isUniqueViolation(error: unknown, depth = 0): boolean {
  if (typeof error !== "object" || error === null || depth > 3) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (candidate.code === "23505") return true;
  return isUniqueViolation(candidate.cause, depth + 1);
}

async function assertNoOtherActiveIssuer(
  db: Db,
  exceptKey?: string,
): Promise<void> {
  const [row] = await db
    .select({
      issuerKey: oauthIssuers.issuerKey,
      displayName: oauthIssuers.displayName,
    })
    .from(oauthIssuers)
    .where(
      exceptKey
        ? and(eq(oauthIssuers.status, "active"), ne(oauthIssuers.issuerKey, exceptKey))
        : eq(oauthIssuers.status, "active"),
    )
    .limit(1);

  if (row) {
    throw new AdminError(
      "issuer_active_exists",
      409,
      `一个商城只能接入一个论坛：已有启用中的 issuer「${row.displayName}」（${row.issuerKey}）。` +
        "要换论坛请先停用当前的——停用只影响登录，历史账号与商品归属保留。",
    );
  }
}

export type IssuerRow = {
  issuerKey: string;
  displayName: string;
  baseUrl: string;
  clientId: string;
  clientSecretKid: string;
  scopes: string[];
  status: "active" | "retired";
  lastVerifiedAt: Date | null;
  lastError: string | null;
  updatedAt: Date;
  accountCount: number;
};

export async function listIssuers(db: Db): Promise<IssuerRow[]> {
  return db
    .select({
      issuerKey: oauthIssuers.issuerKey,
      displayName: oauthIssuers.displayName,
      baseUrl: oauthIssuers.baseUrl,
      clientId: oauthIssuers.clientId,
      clientSecretKid: oauthIssuers.clientSecretKid,
      scopes: oauthIssuers.scopes,
      status: oauthIssuers.status,
      lastVerifiedAt: oauthIssuers.lastVerifiedAt,
      lastError: oauthIssuers.lastError,
      updatedAt: oauthIssuers.updatedAt,
      accountCount: sql<number>`(
        select count(*)::int from accounts
        where accounts.issuer_key = oauth_issuers.issuer_key
      )`,
    })
    .from(oauthIssuers)
    .orderBy(oauthIssuers.displayName);
}

export type IssuerInput = {
  issuerKey: string;
  displayName: string;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
};

const ISSUER_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Validation mirrors what the provider will accept, so a save either works or fails here.
 * `client_id` 8..128 and `client_secret` ≤256 come from the provider's `token.request.json`;
 * a shorter id fails at *every login* with 422 `extensions.route_schema_invalid`.
 */
export function validateIssuerInput(
  input: Partial<IssuerInput>,
  options: { production: boolean; creating: boolean },
): { issuerKey: string; displayName: string; baseUrl: string; clientId: string; clientSecret: string; scopes: string[] } {
  const issuerKey = (input.issuerKey ?? "").trim();
  if (options.creating && !ISSUER_KEY_PATTERN.test(issuerKey)) {
    throw new AdminError(
      "invalid_issuer_key",
      400,
      "issuer_key 需匹配 ^[a-z0-9][a-z0-9-]{0,31}$，创建后不可修改",
    );
  }

  const baseUrlRaw = (input.baseUrl ?? "").trim().replace(/\/+$/, "");
  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlRaw);
  } catch {
    throw new AdminError("invalid_base_url", 400, "base_url 不是合法 URL");
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new AdminError("invalid_base_url", 400, "base_url 只能用 http 或 https");
  }
  const local =
    baseUrl.hostname === "127.0.0.1" ||
    baseUrl.hostname === "localhost" ||
    baseUrl.hostname === "::1";
  if (options.production && baseUrl.protocol !== "https:" && !local) {
    throw new AdminError("invalid_base_url", 400, "生产环境 base_url 必须使用 https");
  }

  const clientId = (input.clientId ?? "").trim();
  if (clientId.length < 8 || clientId.length > 128) {
    throw new AdminError(
      "invalid_client_id",
      400,
      "client_id 必须是 8..128 字符（provider 的 token.request.json 约束）",
    );
  }

  const clientSecret = (input.clientSecret ?? "").trim();
  if (clientSecret.length === 0) {
    throw new AdminError("invalid_client_secret", 400, "client_secret 不能为空");
  }
  if (clientSecret.length > 256) {
    throw new AdminError("invalid_client_secret", 400, "client_secret 最多 256 字符");
  }

  const scopes = Array.from(
    new Set(
      (input.scopes ?? ["profile", "avatar"]).map((scope) => scope.trim()).filter(Boolean),
    ),
  );
  if (!scopes.includes("profile")) scopes.unshift("profile");

  return {
    issuerKey,
    displayName: (input.displayName ?? "").trim() || issuerKey,
    baseUrl: baseUrl.origin + baseUrl.pathname.replace(/\/+$/, ""),
    clientId,
    clientSecret,
    scopes,
  };
}

export async function createIssuer(
  db: Db,
  config: StoreConfig,
  input: IssuerInput,
  actor: { adminId: string; ip?: string | null },
): Promise<void> {
  const value = validateIssuerInput(input, {
    production: config.nodeEnv === "production",
    creating: true,
  });

  const [existing] = await db
    .select({ id: oauthIssuers.id })
    .from(oauthIssuers)
    .where(eq(oauthIssuers.issuerKey, value.issuerKey))
    .limit(1);
  if (existing) throw new AdminError("issuer_exists", 409, "这个 issuer_key 已存在");

  await assertNoOtherActiveIssuer(db);

  const ciphertext = encryptSecret(value.clientSecret, config.keyring);
  try {
    await db.insert(oauthIssuers).values({
      issuerKey: value.issuerKey,
      displayName: value.displayName,
      baseUrl: value.baseUrl,
      clientId: value.clientId,
      clientSecretCiphertext: ciphertext,
      clientSecretKid: ciphertext.split(".")[1] ?? "unknown",
      scopes: value.scopes,
      status: "active",
    });
  } catch (error) {
    // Two concurrent creates both pass the check above; the partial unique index is what
    // actually decides. Report it as the same 409 instead of leaking a 500.
    if (isUniqueViolation(error)) {
      await assertNoOtherActiveIssuer(db);
      throw new AdminError(
        "issuer_active_exists",
        409,
        "已有启用中的 issuer：一个商城只能接入一个论坛，请先停用当前的。",
      );
    }
    throw error;
  }

  await recordAudit(db, {
    actorAdminId: actor.adminId,
    action: "admin.issuer.created",
    targetType: "issuer",
    targetId: value.issuerKey,
    details: { baseUrl: value.baseUrl, clientId: value.clientId, scopes: value.scopes },
    ip: actor.ip ?? null,
  });
}

export async function updateIssuer(
  db: Db,
  config: StoreConfig,
  issuerKey: string,
  input: Partial<IssuerInput> & { status?: "active" | "retired" },
  actor: { adminId: string; ip?: string | null },
): Promise<void> {
  const [existing] = await db
    .select()
    .from(oauthIssuers)
    .where(eq(oauthIssuers.issuerKey, issuerKey))
    .limit(1);
  if (!existing) throw new AdminError("not_found", 404, "issuer 不存在");

  const value = validateIssuerInput(
    {
      issuerKey,
      displayName: input.displayName ?? existing.displayName,
      baseUrl: input.baseUrl ?? existing.baseUrl,
      clientId: input.clientId ?? existing.clientId,
      clientSecret: input.clientSecret ?? "placeholder-secret",
      scopes: input.scopes ?? existing.scopes,
    },
    { production: config.nodeEnv === "production", creating: false },
  );

  // Re-enabling a retired issuer is the other way to end up with two login sources.
  if (input.status === "active" && existing.status !== "active") {
    await assertNoOtherActiveIssuer(db, issuerKey);
  }

  const patch: Record<string, unknown> = {
    displayName: value.displayName,
    baseUrl: value.baseUrl,
    clientId: value.clientId,
    scopes: value.scopes,
    updatedAt: new Date(),
  };
  if (input.status) patch.status = input.status;

  // A new secret replaces the old ciphertext outright — the provider has no dual-secret
  // grace window either, so keeping one would only pretend a rollback is possible.
  if (input.clientSecret) {
    const ciphertext = encryptSecret(value.clientSecret, config.keyring);
    patch.clientSecretCiphertext = ciphertext;
    patch.clientSecretKid = ciphertext.split(".")[1] ?? "unknown";
  }

  await db.update(oauthIssuers).set(patch).where(eq(oauthIssuers.issuerKey, issuerKey));

  await recordAudit(db, {
    actorAdminId: actor.adminId,
    action: "admin.issuer.updated",
    targetType: "issuer",
    targetId: issuerKey,
    // Never the secret: only whether it was rotated and which kid now holds it.
    details: {
      rotatedSecret: Boolean(input.clientSecret),
      status: input.status ?? existing.status,
      baseUrl: value.baseUrl,
      clientId: value.clientId,
    },
    ip: actor.ip ?? null,
  });
}

/**
 * Soft delete. `accounts.issuer_key` references history, so the row stays; a retired issuer
 * simply cannot be used to log in any more.
 */
export async function retireIssuer(
  db: Db,
  issuerKey: string,
  actor: { adminId: string; ip?: string | null },
): Promise<{ activeRemaining: number }> {
  const [existing] = await db
    .select({ id: oauthIssuers.id })
    .from(oauthIssuers)
    .where(eq(oauthIssuers.issuerKey, issuerKey))
    .limit(1);
  if (!existing) throw new AdminError("not_found", 404, "issuer 不存在");

  await db
    .update(oauthIssuers)
    .set({ status: "retired", updatedAt: new Date() })
    .where(eq(oauthIssuers.issuerKey, issuerKey));

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(oauthIssuers)
    .where(eq(oauthIssuers.status, "active"));

  const activeRemaining = row?.count ?? 0;

  await recordAudit(db, {
    actorAdminId: actor.adminId,
    action: "admin.issuer.retired",
    targetType: "issuer",
    targetId: issuerKey,
    details: { activeRemaining },
    ip: actor.ip ?? null,
  });

  return { activeRemaining };
}

export type VerifyResult = { ok: boolean; status: number | null; message: string };

/**
 * Reachability probe. Hits the provider's CSRF endpoint because every plugin route sits
 * behind it — if that answers, the base URL is right. It is a hint, not a gate: a failing
 * probe never disables an issuer.
 */
export async function verifyIssuer(
  db: Db,
  issuerKey: string,
  options: { timeoutMs?: number; adminId?: string; ip?: string | null } = {},
): Promise<VerifyResult> {
  const [row] = await db
    .select({
      baseUrl: oauthIssuers.baseUrl,
      clientId: oauthIssuers.clientId,
    })
    .from(oauthIssuers)
    .where(eq(oauthIssuers.issuerKey, issuerKey))
    .limit(1);
  if (!row) throw new AdminError("not_found", 404, "issuer 不存在");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4000);
  let result: VerifyResult;

  try {
    const response = await fetch(`${row.baseUrl}/api/oauth/csrf`, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (response.ok) {
      result = { ok: true, status: response.status, message: "可达" };
    } else if (response.status === 404) {
      result = {
        ok: false,
        status: 404,
        message: "地址可达，但 /api/oauth/csrf 返回 404：论坛可能没装 sforum-oauth2-provider",
      };
    } else {
      result = { ok: false, status: response.status, message: `返回 HTTP ${response.status}` };
    }
  } catch (error) {
    result = {
      ok: false,
      status: null,
      message:
        error instanceof Error && error.name === "AbortError"
          ? "连接超时"
          : `连接失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }

  await db
    .update(oauthIssuers)
    .set({
      lastVerifiedAt: result.ok ? new Date() : null,
      lastError: result.ok ? null : result.message,
      updatedAt: new Date(),
    })
    .where(eq(oauthIssuers.issuerKey, issuerKey));

  if (options.adminId) {
    await recordAudit(db, {
      actorAdminId: options.adminId,
      action: "admin.issuer.verified",
      targetType: "issuer",
      targetId: issuerKey,
      details: { ok: result.ok, status: result.status, message: result.message },
      ip: options.ip ?? null,
    });
  }

  return result;
}
