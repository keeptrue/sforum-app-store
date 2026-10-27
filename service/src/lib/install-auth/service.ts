import { createHash, timingSafeEqual } from "node:crypto";

import type { Db } from "@/db/client";
import type { accounts } from "@/db/schema";
import { listActiveIssuers } from "@/lib/auth/service";
import {
  ACCOUNT_TOKEN_SCOPE,
  ACCOUNT_TOKEN_TTL_SECONDS,
  AUTH_POLL_INTERVAL_SECONDS,
  AUTH_REQUEST_TTL_SECONDS,
  CLIENT_LABEL_MAX_LENGTH,
  CODE_CHALLENGE_PATTERN,
  LAST_USED_WRITE_INTERVAL_SECONDS,
} from "./constants";
import {
  approveAuthRequest,
  consumeRequestAndInsertToken,
  denyAuthRequest,
  expireAuthRequest,
  findAccountById,
  findAccountTokenByHash,
  findAuthRequest,
  insertAuthRequest,
  revokeAccountToken,
  touchAccountToken,
  type AccountTokenRow,
  type AuthRequestRow,
} from "./store";
import {
  hashAccountToken,
  isAccountTokenShape,
  isValidVerifier,
  mintAccountToken,
} from "./token";

/**
 * The install-gate state machine.
 *
 * `install_auth_requests.status` is the only source of truth:
 *
 *   pending ──approve──▶ approved ──exchange──▶ consumed
 *      │                    │
 *      ├──deny──▶ denied    └──expiry──▶ expired
 *      └──expiry──▶ expired
 *
 * Every transition is a conditional UPDATE in `store.ts`, so the two races that matter —
 * "two tabs approve" and "two exchanges replay" — resolve to exactly one winner.
 */

export type AuthRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "consumed"
  | "expired";

/** What a plugin is allowed to see about its own request: never the account. */
export type AuthRequestStatusView = { status: AuthRequestStatus };

export type AccountView = {
  id: string;
  issuerKey: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

export function accountView(row: typeof accounts.$inferSelect): AccountView {
  return {
    id: row.id,
    issuerKey: row.issuerKey,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
  };
}

export type CreateAuthRequestInput = {
  codeChallenge: string;
  clientLabel: string | null;
  ip: string | null;
  userAgent: string | null;
  publicUrl: string;
};

export type CreateAuthRequestResult =
  | {
      ok: true;
      id: string;
      authorizeUrl: string;
      expiresIn: number;
      interval: number;
    }
  | { ok: false; code: "invalid_request" | "issuer_unavailable" };

/**
 * Open one authorization request.
 *
 * `authorize_url` is built from the *effective* public URL, never from the request's Host
 * header: the plugin compares that origin with its own configured store address, and a
 * Host-header-derived value would either fail that check or send the operator to the wrong
 * host.
 */
export async function createAuthRequest(
  db: Db,
  input: CreateAuthRequestInput,
  now: Date = new Date(),
): Promise<CreateAuthRequestResult> {
  const codeChallenge = input.codeChallenge.trim();
  if (!CODE_CHALLENGE_PATTERN.test(codeChallenge)) {
    return { ok: false, code: "invalid_request" };
  }
  const clientLabel = normalizeClientLabel(input.clientLabel);

  // No issuer means the approval page could never authenticate anyone; say so instead of
  // handing out a link that dead-ends at a login page with nothing to log in to.
  const issuers = await listActiveIssuers(db);
  if (issuers.length === 0) return { ok: false, code: "issuer_unavailable" };

  const row = await insertAuthRequest(db, {
    codeChallenge,
    clientLabel,
    expiresAt: new Date(now.getTime() + AUTH_REQUEST_TTL_SECONDS * 1000),
    intervalSeconds: AUTH_POLL_INTERVAL_SECONDS,
    createdIp: input.ip,
    userAgent: truncate(input.userAgent, 400),
  });

  return {
    ok: true,
    id: row.id,
    authorizeUrl: `${input.publicUrl}/connect/${row.id}`,
    expiresIn: AUTH_REQUEST_TTL_SECONDS,
    interval: row.intervalSeconds,
  };
}

/**
 * Current status, with lazy expiry: a request that timed out while nobody was looking is
 * flipped to `expired` on the next read instead of waiting for the daily sweep.
 */
export async function readAuthRequestStatus(
  db: Db,
  id: string,
  now: Date = new Date(),
): Promise<AuthRequestStatus | null> {
  const row = await findAuthRequest(db, id);
  if (!row) return null;
  if (isOpen(row) && row.expiresAt.getTime() <= now.getTime()) {
    await expireAuthRequest(db, id, now);
    return "expired";
  }
  return row.status;
}

/** The authorize page needs the row itself: label, status, expiry. */
export async function readAuthRequest(
  db: Db,
  id: string,
  now: Date = new Date(),
): Promise<AuthRequestRow | null> {
  const row = await findAuthRequest(db, id);
  if (!row) return null;
  if (isOpen(row) && row.expiresAt.getTime() <= now.getTime()) {
    await expireAuthRequest(db, id, now);
    return { ...row, status: "expired" };
  }
  return row;
}

export type DecisionOutcome =
  | "approved"
  | "denied"
  | "not_pending"
  | "not_found"
  | "expired";

/**
 * Record the operator's decision. Only `pending` rows move: an expired request cannot be
 * approved after the fact, and a second click reports the truth instead of overwriting it.
 */
export async function decideAuthRequest(
  db: Db,
  id: string,
  accountId: string,
  decision: "approve" | "deny",
  now: Date = new Date(),
): Promise<DecisionOutcome> {
  const row = await findAuthRequest(db, id);
  if (!row) return "not_found";
  if (row.status !== "pending") return "not_pending";
  if (row.expiresAt.getTime() <= now.getTime()) {
    await expireAuthRequest(db, id, now);
    return "expired";
  }
  if (decision === "deny") {
    return (await denyAuthRequest(db, id, now)) ? "denied" : "not_pending";
  }
  return (await approveAuthRequest(db, id, accountId, now))
    ? "approved"
    : "not_pending";
}

export type ExchangeFailure =
  | "request_not_found"
  | "request_expired"
  | "request_denied"
  | "request_already_used"
  | "request_not_approved"
  | "invalid_verifier"
  | "pkce_mismatch";

export type ExchangeResult =
  | {
      ok: true;
      accessToken: string;
      expiresAt: Date;
      expiresIn: number;
      scope: string;
      account: AccountView;
    }
  | { ok: false; code: ExchangeFailure };

/**
 * Trade an approved request for an account token.
 *
 * The verifier is checked before the consume, and the consume is what makes it one-shot: a
 * second call — same verifier or not — finds nothing to consume and never mints a token.
 */
export async function exchangeAuthRequest(
  db: Db,
  id: string,
  verifier: string,
  context: { ip: string | null; userAgent: string | null },
  now: Date = new Date(),
): Promise<ExchangeResult> {
  const row = await findAuthRequest(db, id);
  if (!row) return { ok: false, code: "request_not_found" };
  if (isOpen(row) && row.expiresAt.getTime() <= now.getTime()) {
    await expireAuthRequest(db, id, now);
    return { ok: false, code: "request_expired" };
  }
  if (row.status === "denied") return { ok: false, code: "request_denied" };
  if (row.status === "consumed") return { ok: false, code: "request_already_used" };
  if (row.status === "expired") return { ok: false, code: "request_expired" };
  if (row.status !== "approved" || !row.accountId) {
    return { ok: false, code: "request_not_approved" };
  }
  if (!isValidVerifier(verifier)) return { ok: false, code: "invalid_verifier" };
  if (!pkceMatches(verifier, row.codeChallenge)) {
    return { ok: false, code: "pkce_mismatch" };
  }

  const accessToken = mintAccountToken();
  const expiresAt = new Date(now.getTime() + ACCOUNT_TOKEN_TTL_SECONDS * 1000);
  const token = await consumeRequestAndInsertToken(db, {
    requestId: id,
    accountId: row.accountId,
    tokenHash: hashAccountToken(accessToken),
    scope: ACCOUNT_TOKEN_SCOPE,
    expiresAt,
    clientLabel: row.clientLabel,
    createdIp: context.ip,
    userAgent: truncate(context.userAgent, 400),
    now,
  });
  if (!token) return { ok: false, code: "request_already_used" };

  const account = await findAccountForView(db, row.accountId);
  if (!account) return { ok: false, code: "request_not_found" };

  return {
    ok: true,
    accessToken,
    expiresAt,
    expiresIn: ACCOUNT_TOKEN_TTL_SECONDS,
    scope: token.scope,
    account: accountView(account),
  };
}

export type TokenAuthFailure =
  | "login_required"
  | "token_expired"
  | "token_revoked"
  | "account_disabled"
  | "insufficient_scope";

export type TokenAuthResult =
  | {
      ok: true;
      token: AccountTokenRow;
      account: typeof accounts.$inferSelect;
    }
  | { ok: false; code: TokenAuthFailure };

/**
 * Resolve a bearer into the account behind it.
 *
 * Failure codes are stable and separate on purpose: the plugin's copy turns
 * `token_expired`/`token_revoked` into "reconnect", and `login_required` into "not connected
 * yet". `account_disabled` is the store-side kill switch for an orphaned account.
 */
export async function authenticateAccountToken(
  db: Db,
  bearer: string | null,
  now: Date = new Date(),
): Promise<TokenAuthResult> {
  if (!bearer) return { ok: false, code: "login_required" };
  const token = bearer.trim();
  // Shape first: a malformed bearer is not worth a database round trip, and hashing it would
  // still match nothing.
  if (!isAccountTokenShape(token)) return { ok: false, code: "login_required" };

  const row = await findAccountTokenByHash(db, hashAccountToken(token));
  if (!row) return { ok: false, code: "login_required" };
  if (row.token.revokedAt) return { ok: false, code: "token_revoked" };
  if (row.token.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, code: "token_expired" };
  }
  if (row.account.status !== "active") return { ok: false, code: "account_disabled" };
  if (!row.token.scope.split(" ").includes(ACCOUNT_TOKEN_SCOPE)) {
    return { ok: false, code: "insufficient_scope" };
  }

  await touchAccountToken(db, row.token.id, now, LAST_USED_WRITE_INTERVAL_SECONDS);
  return { ok: true, token: row.token, account: row.account };
}

/** Idempotent: the plugin may call this twice while losing the network in between. */
export async function revokeAccountTokenById(
  db: Db,
  tokenId: string,
  now: Date = new Date(),
): Promise<void> {
  await revokeAccountToken(db, tokenId, now);
}

/**
 * Revoke by the bearer itself, regardless of whether it is still usable.
 *
 * Deliberately not routed through `authenticateAccountToken`: an expired-but-not-revoked token
 * must still be markable, otherwise "disconnect" would silently do nothing for exactly the
 * tokens an operator is most likely to be cleaning up.
 */
export async function revokeAccountTokenByBearer(
  db: Db,
  bearer: string | null,
  now: Date = new Date(),
): Promise<boolean> {
  const token = bearer?.trim();
  if (!token || !isAccountTokenShape(token)) return false;
  const row = await findAccountTokenByHash(db, hashAccountToken(token));
  if (!row) return false;
  await revokeAccountToken(db, row.token.id, now);
  return true;
}

/** `Authorization: Bearer <token>` → the token, or null when the header is absent/other. */
export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

function isOpen(row: AuthRequestRow): boolean {
  return row.status === "pending" || row.status === "approved";
}

/**
 * S256 check. Both sides are fixed-length base64url, so a length mismatch is a plain false and
 * an equal-length compare runs in constant time.
 */
function pkceMatches(verifier: string, challenge: string): boolean {
  const expected = Buffer.from(challenge, "utf8");
  const actual = Buffer.from(
    createHash("sha256").update(verifier).digest("base64url"),
    "utf8",
  );
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function normalizeClientLabel(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return truncate(trimmed, CLIENT_LABEL_MAX_LENGTH);
}

function truncate(value: string | null, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

async function findAccountForView(
  db: Db,
  accountId: string,
): Promise<typeof accounts.$inferSelect | null> {
  return findAccountById(db, accountId);
}
