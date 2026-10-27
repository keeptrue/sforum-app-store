import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import { accounts, oauthIssuers, storeSettings } from "@/db/schema";
import { createSession } from "@/lib/auth/service";
import { challengeFor, createVerifier } from "@/lib/oauth/pkce";
import { getConfig, resetConfigForTests } from "@/lib/config";
import { resetRuntimeConfigForTests } from "@/lib/settings/runtime";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import { AUTH_REQUEST_TTL_SECONDS, ACCOUNT_TOKEN_TTL_SECONDS } from "./constants";

/**
 * The HTTP contract the plugin codes against: status codes, response shapes, and the two
 * security gates on the approval form (same-origin, session).
 *
 * Domain behaviour lives in `service.test.ts`; this file only proves the transport does not
 * invent its own rules.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

const PUBLIC_URL = "http://127.0.0.1:3000";

let sessionToken: string | null = null;

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      sessionToken && name === "store_session"
        ? { name, value: sessionToken }
        : undefined,
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers({ host: "127.0.0.1:3000" }),
}));

type ModeRoute = { GET: () => Promise<Response> };
type RequestsRoute = { POST: (request: Request) => Promise<Response> };
type StatusRoute = { GET: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> };
type TokenRoute = { POST: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> };
type MeRoute = { GET: (request: Request) => Promise<Response> };
type RevokeRoute = { POST: (request: Request) => Promise<Response> };
type DecisionRoute = { POST: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> };

let modeRoute: ModeRoute;
let requestsRoute: RequestsRoute;
let statusRoute: StatusRoute;
let tokenRoute: TokenRoute;
let meRoute: MeRoute;
let revokeRoute: RevokeRoute;
let decisionRoute: DecisionRoute;

let db: Db;
let accountId: string;

function jsonRequest(path: string, body: unknown, init: RequestInit = {}): Request {
  return new Request(`${PUBLIC_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
}

function formRequest(path: string, fields: Record<string, string>, origin?: string | null): Request {
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  if (origin !== null) headers.set("origin", origin ?? PUBLIC_URL);
  return new Request(`${PUBLIC_URL}${path}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(fields).toString(),
  });
}

async function openRequest(): Promise<{ id: string; verifier: string }> {
  const verifier = createVerifier();
  const response = await requestsRoute.POST(
    jsonRequest("/api/v1/auth/requests", {
      code_challenge: challengeFor(verifier),
      client_label: "demo forum",
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { id: string };
  return { id: body.id, verifier };
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.STORE_PUBLIC_URL = PUBLIC_URL;
  process.env.STORE_SESSION_SECRET = "s".repeat(64);
  process.env.STORE_DOWNLOAD_SECRET = "d".repeat(64);
  process.env.STORE_SECRET_KEYS = `test1:${Buffer.alloc(32, 9).toString("base64")}`;
  delete process.env.STORE_DOWNLOAD_AUTH_MODE;
  resetConfigForTests();
  resetRuntimeConfigForTests();

  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
  modeRoute = await import("@/app/api/v1/auth/mode/route");
  requestsRoute = await import("@/app/api/v1/auth/requests/route");
  statusRoute = await import("@/app/api/v1/auth/requests/[id]/route");
  tokenRoute = await import("@/app/api/v1/auth/requests/[id]/token/route");
  meRoute = await import("@/app/api/v1/auth/me/route");
  revokeRoute = await import("@/app/api/v1/auth/revoke/route");
  decisionRoute = await import("@/app/api/connect/[id]/decision/route");
});

beforeEach(async () => {
  await getPool().query(TRUNCATE_ALL);
  resetRuntimeConfigForTests();
  sessionToken = null;
  await db.insert(oauthIssuers).values({
    issuerKey: "forum",
    displayName: "Demo Forum",
    baseUrl: "https://forum.example.test",
    clientId: "client-id-for-tests",
    clientSecretCiphertext: "ciphertext-not-used-here",
    clientSecretKid: "test1",
  });
  const [account] = await db
    .insert(accounts)
    .values({ issuerKey: "forum", sub: "sub-ada", username: "ada", status: "active" })
    .returning({ id: accounts.id });
  accountId = account!.id;
  const session = await createSession(db, accountId, { ttlSeconds: 3600 });
  sessionToken = session.token;
});

afterAll(async () => {
  await closeDb();
});

describe("GET /api/v1/auth/mode", () => {
  test("anonymous by default, with the token TTL the plugin should display", async () => {
    const response = await modeRoute.GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      mode: "anonymous",
      token_ttl_seconds: ACCOUNT_TOKEN_TTL_SECONDS,
    });
  });

  test("a saved row flips it to account_required", async () => {
    await db.insert(storeSettings).values({ id: "default", downloadAuthMode: "account_required" });
    resetRuntimeConfigForTests();
    const response = await modeRoute.GET();
    expect(await response.json()).toMatchObject({ mode: "account_required" });
  });

  test("a hand-edited bad value falls back to the seed instead of failing", async () => {
    await db.insert(storeSettings).values({ id: "default", downloadAuthMode: "required" });
    resetRuntimeConfigForTests();
    const response = await modeRoute.GET();
    expect(await response.json()).toMatchObject({ mode: "anonymous" });
  });
});

describe("POST /api/v1/auth/requests", () => {
  test("returns the authorize URL, TTL and polling interval", async () => {
    const verifier = createVerifier();
    const response = await requestsRoute.POST(
      jsonRequest("/api/v1/auth/requests", {
        code_challenge: challengeFor(verifier),
        client_label: "demo forum",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = (await response.json()) as {
      id: string;
      authorize_url: string;
      expires_in: number;
      interval: number;
    };
    expect(body.authorize_url).toBe(`${PUBLIC_URL}/connect/${body.id}`);
    expect(body.expires_in).toBe(AUTH_REQUEST_TTL_SECONDS);
    expect(body.interval).toBe(2);
  });

  test("rejects a body that is not an S256 challenge", async () => {
    for (const body of [{}, { code_challenge: "nope" }, { code_challenge: 42 }]) {
      const response = await requestsRoute.POST(
        jsonRequest("/api/v1/auth/requests", body),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
    const malformed = await requestsRoute.POST(
      new Request(`${PUBLIC_URL}/api/v1/auth/requests`, { method: "POST", body: "{" }),
    );
    expect(malformed.status).toBe(400);
  });

  test("503 when the store has no issuer to log in with", async () => {
    await getPool().query("UPDATE oauth_issuers SET status = 'retired'");
    const response = await requestsRoute.POST(
      jsonRequest("/api/v1/auth/requests", { code_challenge: challengeFor(createVerifier()) }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "issuer_unavailable" });
  });
});

describe("status and exchange", () => {
  test("status exposes only the state", async () => {
    const { id } = await openRequest();
    const response = await statusRoute.GET(new Request(`${PUBLIC_URL}/api/v1/auth/requests/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "pending" });

    const missing = await statusRoute.GET(
      new Request(`${PUBLIC_URL}/api/v1/auth/requests/nope`),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) },
    );
    expect(missing.status).toBe(404);
  });

  test("a poll faster than the advertised interval is asked to slow down", async () => {
    const { id } = await openRequest();
    const first = await statusRoute.GET(new Request(`${PUBLIC_URL}/api/v1/auth/requests/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(first.status).toBe(200);

    const second = await statusRoute.GET(new Request(`${PUBLIC_URL}/api/v1/auth/requests/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ code: "slow_down" });
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("exchange returns the token once, then 409", async () => {
    const { id, verifier } = await openRequest();
    const decision = await decisionRoute.POST(
      formRequest(`/api/connect/${id}/decision`, { decision: "approve" }),
      { params: Promise.resolve({ id }) },
    );
    expect(decision.status).toBe(303);
    expect(decision.headers.get("location")).toBe(`${PUBLIC_URL}/connect/${id}?done=approved`);

    const first = await tokenRoute.POST(
      jsonRequest(`/api/v1/auth/requests/${id}/token`, { code_verifier: verifier }),
      { params: Promise.resolve({ id }) },
    );
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      access_token: string;
      token_type: string;
      scope: string;
      account: { username: string };
    };
    expect(body.token_type).toBe("Bearer");
    expect(body.scope).toBe("download:issue");
    expect(body.account.username).toBe("ada");

    const replay = await tokenRoute.POST(
      jsonRequest(`/api/v1/auth/requests/${id}/token`, { code_verifier: verifier }),
      { params: Promise.resolve({ id }) },
    );
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: "request_already_used" });
  });

  test("a wrong verifier is a 400 and leaves the request usable", async () => {
    const { id, verifier } = await openRequest();
    await decisionRoute.POST(formRequest(`/api/connect/${id}/decision`, { decision: "approve" }), {
      params: Promise.resolve({ id }),
    });
    const wrong = await tokenRoute.POST(
      jsonRequest(`/api/v1/auth/requests/${id}/token`, { code_verifier: createVerifier() }),
      { params: Promise.resolve({ id }) },
    );
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ code: "pkce_mismatch" });

    const ok = await tokenRoute.POST(
      jsonRequest(`/api/v1/auth/requests/${id}/token`, { code_verifier: verifier }),
      { params: Promise.resolve({ id }) },
    );
    expect(ok.status).toBe(200);
  });

  test("an expired request is 410", async () => {
    const { id, verifier } = await openRequest();
    await decisionRoute.POST(formRequest(`/api/connect/${id}/decision`, { decision: "approve" }), {
      params: Promise.resolve({ id }),
    });
    await getPool().query(
      "UPDATE install_auth_requests SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [id],
    );
    const response = await tokenRoute.POST(
      jsonRequest(`/api/v1/auth/requests/${id}/token`, { code_verifier: verifier }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: "request_expired" });
  });
});

describe("me and revoke", () => {
  async function connectedToken(): Promise<string> {
    const { id, verifier } = await openRequest();
    await decisionRoute.POST(formRequest(`/api/connect/${id}/decision`, { decision: "approve" }), {
      params: Promise.resolve({ id }),
    });
    const response = await tokenRoute.POST(
      jsonRequest(`/api/v1/auth/requests/${id}/token`, { code_verifier: verifier }),
      { params: Promise.resolve({ id }) },
    );
    const body = (await response.json()) as { access_token: string };
    return body.access_token;
  }

  test("me answers with the account and the expiry", async () => {
    const token = await connectedToken();
    const response = await meRoute.GET(
      new Request(`${PUBLIC_URL}/api/v1/auth/me`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      account: { username: string };
      expires_at: string;
      scope: string;
    };
    expect(body.account.username).toBe("ada");
    expect(body.scope).toBe("download:issue");
    expect(Number.isNaN(Date.parse(body.expires_at))).toBe(false);
  });

  test("me is 401 with a stable code when there is no usable token", async () => {
    const response = await meRoute.GET(new Request(`${PUBLIC_URL}/api/v1/auth/me`));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "login_required" });
  });

  test("revoke is 204 and the token stops working", async () => {
    const token = await connectedToken();
    const response = await revokeRoute.POST(
      new Request(`${PUBLIC_URL}/api/v1/auth/revoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(204);

    const after = await meRoute.GET(
      new Request(`${PUBLIC_URL}/api/v1/auth/me`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(after.status).toBe(401);
    expect(await after.json()).toMatchObject({ code: "token_revoked" });

    // Idempotent: a second call is still 204, not 401.
    const again = await revokeRoute.POST(
      new Request(`${PUBLIC_URL}/api/v1/auth/revoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(again.status).toBe(204);
  });
});

describe("POST /api/connect/{id}/decision", () => {
  test("rejects a cross-origin post before looking at the session", async () => {
    const { id } = await openRequest();
    const response = await decisionRoute.POST(
      formRequest(`/api/connect/${id}/decision`, { decision: "approve" }, "https://evil.example"),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "origin_mismatch" });
  });

  test("sends a logged-out visitor through the forum login and back", async () => {
    const { id } = await openRequest();
    sessionToken = null;
    const response = await decisionRoute.POST(
      formRequest(`/api/connect/${id}/decision`, { decision: "approve" }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${PUBLIC_URL}/api/auth/sforum/start?redirect=${encodeURIComponent(`/connect/${id}`)}`,
    );
  });

  test("deny is recorded and reported back on the receipt", async () => {
    const { id } = await openRequest();
    const response = await decisionRoute.POST(
      formRequest(`/api/connect/${id}/decision`, { decision: "deny" }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${PUBLIC_URL}/connect/${id}?done=denied`);
    const status = await statusRoute.GET(
      new Request(`${PUBLIC_URL}/api/v1/auth/requests/${id}`),
      { params: Promise.resolve({ id }) },
    );
    expect(await status.json()).toEqual({ status: "denied" });
  });

  test("a missing decision field is a 400", async () => {
    const { id } = await openRequest();
    const response = await decisionRoute.POST(
      formRequest(`/api/connect/${id}/decision`, { decision: "maybe" }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(400);
  });

  test("a second decision does not overwrite the first", async () => {
    const { id } = await openRequest();
    await decisionRoute.POST(formRequest(`/api/connect/${id}/decision`, { decision: "approve" }), {
      params: Promise.resolve({ id }),
    });
    const second = await decisionRoute.POST(
      formRequest(`/api/connect/${id}/decision`, { decision: "deny" }),
      { params: Promise.resolve({ id }) },
    );
    expect(second.status).toBe(303);
    expect(second.headers.get("location")).toBe(`${PUBLIC_URL}/connect/${id}?done=not_pending`);
    const status = await statusRoute.GET(
      new Request(`${PUBLIC_URL}/api/v1/auth/requests/${id}`),
      { params: Promise.resolve({ id }) },
    );
    expect(await status.json()).toEqual({ status: "approved" });
  });

  test("an unknown request id is a 400-ish miss, never a redirect to approval", async () => {
    const response = await decisionRoute.POST(
      formRequest("/api/connect/11111111-1111-4111-8111-111111111111/decision", {
        decision: "approve",
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("done=not_pending");
  });
});

describe("credential hygiene", () => {
  test("no response body carries a verifier or the token hash", async () => {
    const { id, verifier } = await openRequest();
    await decisionRoute.POST(formRequest(`/api/connect/${id}/decision`, { decision: "approve" }), {
      params: Promise.resolve({ id }),
    });
    const response = await tokenRoute.POST(
      jsonRequest(`/api/v1/auth/requests/${id}/token`, { code_verifier: verifier }),
      { params: Promise.resolve({ id }) },
    );
    const text = await response.text();
    expect(text).not.toContain(verifier);

    const [row] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(row?.username).toBe("ada");
    // The token row is the only place the hash exists; it never leaves the database.
    const hashes = await getPool().query("SELECT token_hash FROM account_tokens");
    expect(hashes.rows).toHaveLength(1);
    expect(text).not.toContain(hashes.rows[0].token_hash);
  });
});
