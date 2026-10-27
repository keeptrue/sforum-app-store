import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import { accountTokens, accounts, installAuthRequests, oauthIssuers } from "@/db/schema";
import { challengeFor, createVerifier } from "@/lib/oauth/pkce";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import {
  ACCOUNT_TOKEN_SCOPE,
  ACCOUNT_TOKEN_TTL_SECONDS,
  AUTH_REQUEST_TTL_SECONDS,
  AUTH_POLL_INTERVAL_SECONDS,
} from "./constants";
import {
  authenticateAccountToken,
  createAuthRequest,
  decideAuthRequest,
  exchangeAuthRequest,
  readAuthRequest,
  readAuthRequestStatus,
  revokeAccountTokenByBearer,
} from "./service";
import { isAccountTokenShape } from "./token";

/**
 * The install gate's state machine against a real Postgres.
 *
 * The load-bearing assertions are the two "exactly once" properties — an approved request can
 * be exchanged once, and a decision can be recorded once — plus the 401 matrix the plugin
 * branches on. Everything else is transport and lives in `routes.test.ts`.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

const PUBLIC_URL = "http://127.0.0.1:3000";

let db: Db;
let accountId: string;
let otherAccountId: string;

const CONTEXT = { ip: "127.0.0.1", userAgent: "bun-test" };

async function seedAccount(sub: string, username: string): Promise<string> {
  const [row] = await db
    .insert(accounts)
    .values({
      issuerKey: "forum",
      sub,
      username,
      displayName: username,
      status: "active",
    })
    .returning({ id: accounts.id });
  return row!.id;
}

/** Create → approve, returning the request id and its verifier. */
async function approvedRequest(
  verifier = createVerifier(),
): Promise<{ id: string; verifier: string }> {
  const created = await createAuthRequest(db, {
    codeChallenge: challengeFor(verifier),
    clientLabel: "demo forum",
    ip: CONTEXT.ip,
    userAgent: CONTEXT.userAgent,
    publicUrl: PUBLIC_URL,
  });
  if (!created.ok) throw new Error(`create failed: ${created.code}`);
  const outcome = await decideAuthRequest(db, created.id, accountId, "approve");
  if (outcome !== "approved") throw new Error(`approve failed: ${outcome}`);
  return { id: created.id, verifier };
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.STORE_PUBLIC_URL = PUBLIC_URL;
  process.env.STORE_SESSION_SECRET = "s".repeat(64);
  process.env.STORE_DOWNLOAD_SECRET = "d".repeat(64);
  process.env.STORE_SECRET_KEYS = `test1:${Buffer.alloc(32, 5).toString("base64")}`;
  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
});

beforeEach(async () => {
  await getPool().query(TRUNCATE_ALL);
  await db.insert(oauthIssuers).values({
    issuerKey: "forum",
    displayName: "Demo Forum",
    baseUrl: "https://forum.example.test",
    clientId: "client-id-for-tests",
    clientSecretCiphertext: "ciphertext-not-used-here",
    clientSecretKid: "test1",
  });
  accountId = await seedAccount("sub-ada", "ada");
  otherAccountId = await seedAccount("sub-grace", "grace");
});

afterAll(async () => {
  await closeDb();
});

describe("creating a request", () => {
  test("opens a pending request and points at /connect/{id}", async () => {
    const created = await createAuthRequest(db, {
      codeChallenge: challengeFor(createVerifier()),
      clientLabel: "  demo forum  ",
      ip: CONTEXT.ip,
      userAgent: CONTEXT.userAgent,
      publicUrl: PUBLIC_URL,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.authorizeUrl).toBe(`${PUBLIC_URL}/connect/${created.id}`);
    expect(created.expiresIn).toBe(AUTH_REQUEST_TTL_SECONDS);
    expect(created.interval).toBe(AUTH_POLL_INTERVAL_SECONDS);

    const row = await readAuthRequest(db, created.id);
    expect(row?.status).toBe("pending");
    expect(row?.clientLabel).toBe("demo forum");
    expect(await readAuthRequestStatus(db, created.id)).toBe("pending");
  });

  test("refuses a challenge that is not S256 base64url", async () => {
    for (const challenge of ["", "short", "a".repeat(44), "a".repeat(42) + "="]) {
      const created = await createAuthRequest(db, {
        codeChallenge: challenge,
        clientLabel: null,
        ip: null,
        userAgent: null,
        publicUrl: PUBLIC_URL,
      });
      expect(created).toEqual({ ok: false, code: "invalid_request" });
    }
  });

  test("refuses to open a request when no issuer is configured", async () => {
    await getPool().query("UPDATE oauth_issuers SET status = 'retired'");
    const created = await createAuthRequest(db, {
      codeChallenge: challengeFor(createVerifier()),
      clientLabel: null,
      ip: null,
      userAgent: null,
      publicUrl: PUBLIC_URL,
    });
    expect(created).toEqual({ ok: false, code: "issuer_unavailable" });
  });

  test("truncates the untrusted client label", async () => {
    const created = await createAuthRequest(db, {
      codeChallenge: challengeFor(createVerifier()),
      clientLabel: "x".repeat(200),
      ip: null,
      userAgent: null,
      publicUrl: PUBLIC_URL,
    });
    if (!created.ok) throw new Error("create failed");
    const row = await readAuthRequest(db, created.id);
    expect(row?.clientLabel).toHaveLength(64);
  });
});

describe("deciding a request", () => {
  test("approve then a second decision reports the truth", async () => {
    const verifier = createVerifier();
    const created = await createAuthRequest(db, {
      codeChallenge: challengeFor(verifier),
      clientLabel: null,
      ip: null,
      userAgent: null,
      publicUrl: PUBLIC_URL,
    });
    if (!created.ok) throw new Error("create failed");

    expect(await decideAuthRequest(db, created.id, accountId, "approve")).toBe("approved");
    expect(await decideAuthRequest(db, created.id, otherAccountId, "approve")).toBe("not_pending");
    expect(await decideAuthRequest(db, created.id, accountId, "deny")).toBe("not_pending");

    const row = await readAuthRequest(db, created.id);
    expect(row?.accountId).toBe(accountId);
  });

  test("deny is terminal and issues nothing", async () => {
    const verifier = createVerifier();
    const created = await createAuthRequest(db, {
      codeChallenge: challengeFor(verifier),
      clientLabel: null,
      ip: null,
      userAgent: null,
      publicUrl: PUBLIC_URL,
    });
    if (!created.ok) throw new Error("create failed");

    expect(await decideAuthRequest(db, created.id, accountId, "deny")).toBe("denied");
    const exchanged = await exchangeAuthRequest(db, created.id, verifier, CONTEXT);
    expect(exchanged).toEqual({ ok: false, code: "request_denied" });
    const rows = await db.select().from(accountTokens);
    expect(rows).toHaveLength(0);
  });

  test("an expired request cannot be approved afterwards", async () => {
    const created = await createAuthRequest(db, {
      codeChallenge: challengeFor(createVerifier()),
      clientLabel: null,
      ip: null,
      userAgent: null,
      publicUrl: PUBLIC_URL,
    });
    if (!created.ok) throw new Error("create failed");

    const later = new Date(Date.now() + (AUTH_REQUEST_TTL_SECONDS + 1) * 1000);
    expect(await decideAuthRequest(db, created.id, accountId, "approve", later)).toBe("expired");
    expect(await readAuthRequestStatus(db, created.id, later)).toBe("expired");
    const row = await readAuthRequest(db, created.id);
    expect(row?.status).toBe("expired");
    expect(row?.accountId).toBeNull();
  });
});

describe("exchanging an approved request", () => {
  test("mints one account token with the documented shape", async () => {
    const { id, verifier } = await approvedRequest();
    const exchanged = await exchangeAuthRequest(db, id, verifier, CONTEXT);
    expect(exchanged.ok).toBe(true);
    if (!exchanged.ok) return;

    expect(isAccountTokenShape(exchanged.accessToken)).toBe(true);
    expect(exchanged.scope).toBe(ACCOUNT_TOKEN_SCOPE);
    expect(exchanged.expiresIn).toBe(ACCOUNT_TOKEN_TTL_SECONDS);
    expect(exchanged.account.id).toBe(accountId);
    expect(exchanged.account.username).toBe("ada");
    // The token row stores only the hash.
    const [row] = await db.select().from(accountTokens);
    expect(row?.tokenHash).toHaveLength(64);
    expect(row?.tokenHash).not.toContain(exchanged.accessToken);
    expect(row?.scope).toBe(ACCOUNT_TOKEN_SCOPE);
  });

  test("is one-shot: the same verifier cannot mint a second token", async () => {
    const { id, verifier } = await approvedRequest();
    const first = await exchangeAuthRequest(db, id, verifier, CONTEXT);
    expect(first.ok).toBe(true);
    const replay = await exchangeAuthRequest(db, id, verifier, CONTEXT);
    expect(replay).toEqual({ ok: false, code: "request_already_used" });
    const rows = await db.select().from(accountTokens);
    expect(rows).toHaveLength(1);
    expect(await readAuthRequestStatus(db, id)).toBe("consumed");
  });

  test("a wrong verifier does not burn the request", async () => {
    const { id, verifier } = await approvedRequest();
    const wrong = await exchangeAuthRequest(db, id, createVerifier(), CONTEXT);
    expect(wrong).toEqual({ ok: false, code: "pkce_mismatch" });
    expect(await readAuthRequestStatus(db, id)).toBe("approved");

    const short = await exchangeAuthRequest(db, id, "too-short", CONTEXT);
    expect(short).toEqual({ ok: false, code: "invalid_verifier" });
    expect(await readAuthRequestStatus(db, id)).toBe("approved");

    const ok = await exchangeAuthRequest(db, id, verifier, CONTEXT);
    expect(ok.ok).toBe(true);
  });

  test("an unapproved request cannot be exchanged", async () => {
    const verifier = createVerifier();
    const created = await createAuthRequest(db, {
      codeChallenge: challengeFor(verifier),
      clientLabel: null,
      ip: null,
      userAgent: null,
      publicUrl: PUBLIC_URL,
    });
    if (!created.ok) throw new Error("create failed");
    expect(await exchangeAuthRequest(db, created.id, verifier, CONTEXT)).toEqual({
      ok: false,
      code: "request_not_approved",
    });
  });

  test("an approved request that timed out cannot be exchanged", async () => {
    const { id, verifier } = await approvedRequest();
    const later = new Date(Date.now() + (AUTH_REQUEST_TTL_SECONDS + 1) * 1000);
    expect(await exchangeAuthRequest(db, id, verifier, CONTEXT, later)).toEqual({
      ok: false,
      code: "request_expired",
    });
    expect(await readAuthRequestStatus(db, id)).toBe("expired");
  });

  test("an unknown id is a clean miss", async () => {
    expect(
      await exchangeAuthRequest(db, "11111111-1111-4111-8111-111111111111", createVerifier(), CONTEXT),
    ).toEqual({ ok: false, code: "request_not_found" });
    expect(await readAuthRequestStatus(db, "11111111-1111-4111-8111-111111111111")).toBeNull();
  });
});

describe("using the account token", () => {
  async function freshToken(): Promise<string> {
    const { id, verifier } = await approvedRequest();
    const exchanged = await exchangeAuthRequest(db, id, verifier, CONTEXT);
    if (!exchanged.ok) throw new Error("exchange failed");
    return exchanged.accessToken;
  }

  test("resolves to the approving account", async () => {
    const token = await freshToken();
    const auth = await authenticateAccountToken(db, token);
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(auth.account.id).toBe(accountId);
    expect(auth.token.scope).toBe(ACCOUNT_TOKEN_SCOPE);

    const [row] = await db.select().from(accountTokens);
    expect(row?.lastUsedAt).not.toBeNull();
  });

  test("throttles last_used_at writes", async () => {
    const token = await freshToken();
    await authenticateAccountToken(db, token);
    const [first] = await db.select().from(accountTokens);
    const stamp = first!.lastUsedAt!.getTime();

    // Inside the 60 s window: the row must not be rewritten.
    await authenticateAccountToken(db, token, new Date(stamp + 5_000));
    const [second] = await db.select().from(accountTokens);
    expect(second?.lastUsedAt?.getTime()).toBe(stamp);
  });

  test("401 matrix: missing, malformed, unknown, revoked, expired, disabled, unscoped", async () => {
    expect(await authenticateAccountToken(db, null)).toEqual({
      ok: false,
      code: "login_required",
    });
    expect(await authenticateAccountToken(db, "not-a-token")).toEqual({
      ok: false,
      code: "login_required",
    });
    expect(await authenticateAccountToken(db, `sfo_${"a".repeat(43)}`)).toEqual({
      ok: false,
      code: "login_required",
    });

    const token = await freshToken();
    await db
      .update(accountTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(accountTokens.accountId, accountId));
    expect(await authenticateAccountToken(db, token)).toEqual({
      ok: false,
      code: "token_expired",
    });

    await db
      .update(accountTokens)
      .set({ expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date() })
      .where(eq(accountTokens.accountId, accountId));
    expect(await authenticateAccountToken(db, token)).toEqual({
      ok: false,
      code: "token_revoked",
    });

    await db
      .update(accountTokens)
      .set({ revokedAt: null, scope: "something:else" })
      .where(eq(accountTokens.accountId, accountId));
    expect(await authenticateAccountToken(db, token)).toEqual({
      ok: false,
      code: "insufficient_scope",
    });

    await db
      .update(accountTokens)
      .set({ scope: ACCOUNT_TOKEN_SCOPE })
      .where(eq(accountTokens.accountId, accountId));
    await db
      .update(accounts)
      .set({ status: "orphaned" })
      .where(eq(accounts.id, accountId));
    expect(await authenticateAccountToken(db, token)).toEqual({
      ok: false,
      code: "account_disabled",
    });
  });

  test("revoking by bearer is idempotent and works on expired tokens", async () => {
    const token = await freshToken();
    expect(await revokeAccountTokenByBearer(db, token)).toBe(true);
    expect(await revokeAccountTokenByBearer(db, token)).toBe(true);
    const [row] = await db.select().from(accountTokens);
    expect(row?.revokedAt).not.toBeNull();
    expect(await authenticateAccountToken(db, token)).toEqual({
      ok: false,
      code: "token_revoked",
    });

    // Expired-but-not-revoked: still markable, so "disconnect" is never a silent no-op.
    const second = await freshToken();
    await db
      .update(accountTokens)
      .set({ expiresAt: new Date(Date.now() - 1000), revokedAt: null })
      .where(eq(accountTokens.accountId, accountId));
    expect(await revokeAccountTokenByBearer(db, second)).toBe(true);

    expect(await revokeAccountTokenByBearer(db, null)).toBe(false);
    expect(await revokeAccountTokenByBearer(db, "garbage")).toBe(false);
  });
});

describe("cleanup contract", () => {
  test("a request row keeps no verifier and no plaintext token", async () => {
    const { id, verifier } = await approvedRequest();
    const exchanged = await exchangeAuthRequest(db, id, verifier, CONTEXT);
    if (!exchanged.ok) throw new Error("exchange failed");

    const [request] = await db
      .select()
      .from(installAuthRequests)
      .where(eq(installAuthRequests.id, id));
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain(verifier);
    expect(serialized).not.toContain(exchanged.accessToken);
    expect(request?.codeChallenge).not.toBe(verifier);
  });
});
