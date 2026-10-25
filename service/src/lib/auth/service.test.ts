import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import { accounts, storeRoles } from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import type { StoreConfig } from "@/lib/config";
import { resetConfigForTests } from "@/lib/config";
import { challengeFor } from "@/lib/oauth/pkce";
import { startFakeProvider } from "../../../test/fake-provider";
import { seedIssuer } from "../../../test/issuer-fixture";
import {
  completeLogin,
  createSession,
  deleteSessionByToken,
  findSession,
  loadTokenSet,
  refreshAccountTokens,
  revokeAccountTokens,
} from "./service";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";
const redirectUri = "http://127.0.0.1:3000/api/auth/sforum/callback";
// 43 characters: the provider schema declares `code_verifier: minLength 43`.
const verifier = "verifier-for-service-test-0123456789abcdefghij";

let fake: ReturnType<typeof startFakeProvider>;
let db: Db;
let config: StoreConfig;

beforeAll(async () => {
  fake = startFakeProvider();

  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.STORE_PUBLIC_URL = "http://127.0.0.1:3000";
  process.env.STORE_SESSION_SECRET = "s".repeat(64);
  process.env.STORE_DOWNLOAD_SECRET = "d".repeat(64);
  process.env.STORE_SECRET_KEYS = `test1:${Buffer.alloc(32, 5).toString("base64")}`;
  resetConfigForTests();

  const { getConfig } = await import("@/lib/config");
  config = getConfig();
  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
  await getPool().query(TRUNCATE_ALL);
  await seedIssuer(db, config, { baseUrl: fake.url });
});

afterAll(async () => {
  await closeDb();
  fake.server.stop(true);
  resetConfigForTests();
});

describe("auth service", () => {
  test("logs in, creates a session, rotates tokens and revokes", async () => {
    const code = fake.issueCode({
      user: {
        sub: "1",
        username: "lin",
        name: "Lin",
        avatar_url: "https://example.com/avatar.png",
        email: "lin@example.com",
        email_verified: true,
      },
      redirectUri,
      challenge: challengeFor(verifier),
    });

    const result = await completeLogin({
      db,
      config,
      issuerKey: "official",
      code,
      verifier,
      redirectUri,
      userAgent: "bun-test",
      ip: "127.0.0.1",
    });

    expect(result.account.sub).toBe("1");
    expect(result.account.issuerKey).toBe("official");
    // Roles come from `store_roles` only; the store no longer grants admin at login.
    expect(result.roles).toEqual([]);
    expect(result.sessionToken.length).toBeGreaterThan(30);

    const tokenSet = await loadTokenSet(db, result.account.id);
    expect(tokenSet?.accessTokenCiphertext.startsWith("v1.")).toBe(true);
    expect(tokenSet?.accessTokenCiphertext).not.toContain("at_");
    expect(tokenSet?.refreshTokenCiphertext?.startsWith("v1.")).toBe(true);

    const session = await findSession(db, result.sessionToken);
    expect(session?.account.id).toBe(result.account.id);
    expect(session?.roles).toEqual([]);

    const firstCiphertext = tokenSet!.accessTokenCiphertext;
    const refreshed = await refreshAccountTokens(db, config, result.account.id);
    expect(refreshed.expiresAt).not.toBeNull();
    expect(fake.state.refreshRotations).toBe(1);

    const rotated = await loadTokenSet(db, result.account.id);
    expect(rotated?.accessTokenCiphertext).not.toBe(firstCiphertext);

    await revokeAccountTokens(db, config, result.account.id);
    expect(await loadTokenSet(db, result.account.id)).toBeNull();
    expect(fake.state.revoked.length).toBeGreaterThan(0);

    await deleteSessionByToken(db, result.sessionToken);
    expect(await findSession(db, result.sessionToken)).toBeNull();
  });

  test("a legacy store_roles 'admin' row grants no session role", async () => {
    const [account] = await db
      .insert(accounts)
      .values({ issuerKey: "official", sub: "legacy-admin", username: "legacy" })
      .returning({ id: accounts.id });
    await db.insert(storeRoles).values({ accountId: account!.id, role: "admin" });

    const created = await createSession(db, account!.id, { ttlSeconds: 60 });
    const session = await findSession(db, created.token);
    // The store's administrator is a local account; a leftover forum-side row is inert.
    expect(session?.roles).toEqual([]);
  });
});
