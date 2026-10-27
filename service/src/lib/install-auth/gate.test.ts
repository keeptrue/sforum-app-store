import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { PoolClient } from "pg";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import {
  accountTokens,
  accounts,
  auditLog,
  githubRepos,
  oauthIssuers,
  products,
  releaseAssets,
  releaseVersions,
  repoReleases,
} from "@/db/schema";
import { GET as redirectToDownload } from "@/app/api/v1/products/[slug]/download/[os]/[arch]/route";
import { POST as createDownloadUrl } from "@/app/api/v1/download-urls/route";
import { createSession } from "@/lib/auth/service";
import { getConfig, resetConfigForTests } from "@/lib/config";
import { hashAccountToken, mintAccountToken } from "@/lib/install-auth/token";
import { getRuntimeConfig, resetRuntimeConfigForTests } from "@/lib/settings/runtime";
import { saveStoreSettings } from "@/lib/settings/service";
import { TRUNCATE_ALL, TRUNCATE_TABLES } from "@/lib/test-support/db";
import { verifyDownloadToken } from "@/lib/download/token";
import { registerFirstAdmin } from "@/lib/admin/setup";

/**
 * The install gate as the two download entry points see it.
 *
 * `anonymous` must behave exactly like it did before the feature existed; `account_required`
 * must answer the five 401 codes the plugin branches on, and the browser route must bounce a
 * logged-out visitor into the forum login with this exact path as the return address.
 *
 * Separate file from `download/issue.test.ts` because this suite needs a `next/headers` mock
 * (the browser route reads the session cookie) and Bun module mocks are bound at import time.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

const PUBLIC_URL = "http://127.0.0.1:3999";
const DOWNLOAD_SECRET = "d".repeat(64);
const DIGEST = "a".repeat(64);
const SETUP_TOKEN = "setup-token-for-tests-0123456789";

let sessionCookie: string | null = null;

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      sessionCookie && name === "store_session"
        ? { name, value: sessionCookie }
        : undefined,
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers({ host: "127.0.0.1:3999" }),
}));

let db: Db;
let dbGuard: PoolClient;
let guardOpen = false;
let accountId: string;
let adminId: string;
let repoCounter = 5150;
let releaseCounter = 1200;

/** Same guard as `download/issue.test.ts`: parallel suites must not truncate mid-assertion. */
async function resetDatabase(): Promise<void> {
  if (guardOpen) {
    await dbGuard.query("COMMIT");
    guardOpen = false;
  }
  await withRetry(() => dbGuard.query(TRUNCATE_ALL));
  await withRetry(async () => {
    await dbGuard.query("BEGIN");
    await dbGuard.query("SET LOCAL lock_timeout = '2000ms'");
    try {
      await dbGuard.query(`LOCK TABLE ${TRUNCATE_TABLES.join(", ")} IN ACCESS SHARE MODE`);
    } catch (error) {
      await dbGuard.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
  guardOpen = true;
}

async function withRetry(run: () => Promise<unknown>): Promise<void> {
  const retryable = new Set(["40P01", "40001", "55P03"]);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await run();
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (attempt >= 4 || !code || !retryable.has(code)) throw error;
      await Bun.sleep(50 * (attempt + 1));
    }
  }
}

async function seedProduct(): Promise<void> {
  const repoId = ++repoCounter;
  await db.insert(githubRepos).values({
    repoId,
    installationId: 77,
    fullName: "octo/gated",
    upstreamState: "connected",
  });
  const [product] = await db
    .insert(products)
    .values({
      extensionId: "sforum.gated",
      name: "gated",
      kind: "plugin",
      slug: "gated",
      status: "published",
      repoId,
    })
    .returning({ id: products.id });

  const [release] = await db
    .insert(repoReleases)
    .values({ repoId, githubReleaseId: ++releaseCounter, tag: "v1.0.0" })
    .returning({ id: repoReleases.id });

  const [version] = await db
    .insert(releaseVersions)
    .values({
      productId: product!.id,
      repoReleaseId: release!.id,
      version: "1.0.0",
      channel: "stable",
      state: "published",
      sforumVersionConstraint: ">=1.0.0",
    })
    .returning({ id: releaseVersions.id });

  await db
    .update(products)
    .set({ latestStableVersionId: version!.id })
    .where(eq(products.id, product!.id));

  await db.insert(releaseAssets).values({
    releaseVersionId: version!.id,
    os: "linux",
    arch: "amd64",
    filename: "gated-linux-amd64.zip",
    size: 512,
    sha256: DIGEST,
    upstreamAssetId: 555,
    detectionSource: "header",
  });
}

/** One live account token, inserted the way the exchange would have written it. */
async function seedAccountToken(
  options: { expiresAt?: Date; revokedAt?: Date | null; scope?: string } = {},
): Promise<string> {
  const token = mintAccountToken();
  await db.insert(accountTokens).values({
    accountId,
    tokenHash: hashAccountToken(token),
    scope: options.scope ?? "download:issue",
    expiresAt: options.expiresAt ?? new Date(Date.now() + 86_400_000),
    revokedAt: options.revokedAt ?? null,
    clientLabel: "demo forum",
  });
  return token;
}

function downloadRequest(headers: Record<string, string> = {}): Request {
  return new Request(`${PUBLIC_URL}/api/v1/download-urls`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ product: "gated", os: "linux", arch: "amd64" }),
  });
}

function browserRequest(): Request {
  return new Request(`${PUBLIC_URL}/api/v1/products/gated/download/linux/amd64`);
}

const browserContext = {
  params: Promise.resolve({ slug: "gated", os: "linux", arch: "amd64" }),
};

async function setMode(mode: "anonymous" | "account_required"): Promise<void> {
  await saveStoreSettings(
    db,
    {
      publicUrl: PUBLIC_URL,
      downloadTtlSeconds: null,
      downloadMode: null,
      downloadAuthMode: mode,
      rateLimits: undefined,
    },
    { adminId, ip: null },
    { requestOrigin: PUBLIC_URL, requestProtocol: "http:", requestHost: "127.0.0.1:3999" },
  );
  resetRuntimeConfigForTests();
}

const ENV_KEYS = [
  "DATABASE_URL",
  "NODE_ENV",
  "STORE_PUBLIC_URL",
  "STORE_SESSION_SECRET",
  "STORE_DOWNLOAD_SECRET",
  "STORE_SECRET_KEYS",
  "STORE_ADMIN_SETUP_TOKEN",
  "STORE_DOWNLOAD_AUTH_MODE",
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.NODE_ENV = "test";
  process.env.STORE_PUBLIC_URL = PUBLIC_URL;
  process.env.STORE_SESSION_SECRET = "s".repeat(64);
  process.env.STORE_DOWNLOAD_SECRET = DOWNLOAD_SECRET;
  process.env.STORE_SECRET_KEYS = `k1:${Buffer.alloc(32, 3).toString("base64")}`;
  process.env.STORE_ADMIN_SETUP_TOKEN = SETUP_TOKEN;
  delete process.env.STORE_DOWNLOAD_AUTH_MODE;
  resetConfigForTests();
  resetRuntimeConfigForTests();

  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
  dbGuard = await getPool().connect();
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  resetRuntimeConfigForTests();
  sessionCookie = null;
  repoCounter = 5150;
  releaseCounter = 1200;

  const config = getConfig();
  await db.insert(oauthIssuers).values({
    issuerKey: "forum",
    displayName: "Demo Forum",
    baseUrl: "https://forum.example.test",
    clientId: "client-id-for-tests",
    clientSecretCiphertext: "ciphertext-not-used-here",
    clientSecretKid: "k1",
  });
  const [account] = await db
    .insert(accounts)
    .values({ issuerKey: "forum", sub: "sub-ada", username: "ada", status: "active" })
    .returning({ id: accounts.id });
  accountId = account!.id;
  const admin = await registerFirstAdmin(db, config, {
    token: SETUP_TOKEN,
    username: "root",
    password: "initial-password-123",
  });
  adminId = admin.id;

  await seedProduct();
});

afterAll(async () => {
  try {
    if (guardOpen) await dbGuard.query("COMMIT");
  } finally {
    if (dbGuard) dbGuard.release();
    await closeDb();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
    resetRuntimeConfigForTests();
    resetConfigForTests();
  }
});

describe("download-urls in anonymous mode", () => {
  test("issues without any credential", async () => {
    const response = await createDownloadUrl(downloadRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };
    const token = body.url.split("/").pop()!;
    expect(verifyDownloadToken(token, DOWNLOAD_SECRET).ok).toBe(true);
  });

  test("ignores a token that does not resolve, instead of turning it into a 401", async () => {
    const response = await createDownloadUrl(
      downloadRequest({ authorization: `Bearer sfo_${"a".repeat(43)}` }),
    );
    expect(response.status).toBe(200);
  });

  test("validates a token that is present and audits the issuance", async () => {
    const token = await seedAccountToken();
    const response = await createDownloadUrl(
      downloadRequest({ authorization: `Bearer ${token}` }),
    );
    expect(response.status).toBe(200);

    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "download.issued"))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(row?.actorAccountId).toBe(accountId);
    expect(row?.targetType).toBe("product");
    expect(row?.details).toMatchObject({
      version: "1.0.0",
      os: "linux",
      arch: "amd64",
      mode: "anonymous",
    });
    // The signature is a bearer credential: it must never reach the audit trail.
    const serialized = JSON.stringify(row?.details);
    expect(serialized).not.toContain("sfo_");
    expect(serialized).not.toContain("/api/v1/download/");
  });

  test("anonymous issuance writes no audit row at all", async () => {
    await createDownloadUrl(downloadRequest());
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, "download.issued"));
    expect(rows).toHaveLength(0);
  });
});

describe("download-urls in account_required mode", () => {
  test("401 login_required without a token", async () => {
    await setMode("account_required");
    const response = await createDownloadUrl(downloadRequest());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "login_required" });
  });

  test("401 with the code that matches why the token is unusable", async () => {
    await setMode("account_required");

    const expired = await seedAccountToken({ expiresAt: new Date(Date.now() - 1000) });
    expect(
      (await createDownloadUrl(downloadRequest({ authorization: `Bearer ${expired}` }))).status,
    ).toBe(401);
    expect(
      await (await createDownloadUrl(downloadRequest({ authorization: `Bearer ${expired}` }))).json(),
    ).toMatchObject({ code: "token_expired" });

    const revoked = await seedAccountToken({ revokedAt: new Date() });
    const revokedResponse = await createDownloadUrl(
      downloadRequest({ authorization: `Bearer ${revoked}` }),
    );
    expect(revokedResponse.status).toBe(401);
    expect(await revokedResponse.json()).toMatchObject({ code: "token_revoked" });

    const unscoped = await seedAccountToken({ scope: "other:scope" });
    const unscopedResponse = await createDownloadUrl(
      downloadRequest({ authorization: `Bearer ${unscoped}` }),
    );
    expect(unscopedResponse.status).toBe(401);
    expect(await unscopedResponse.json()).toMatchObject({ code: "insufficient_scope" });

    await db.update(accounts).set({ status: "orphaned" }).where(eq(accounts.id, accountId));
    const live = await seedAccountToken();
    const disabledResponse = await createDownloadUrl(
      downloadRequest({ authorization: `Bearer ${live}` }),
    );
    expect(disabledResponse.status).toBe(401);
    expect(await disabledResponse.json()).toMatchObject({ code: "account_disabled" });
  });

  test("a valid token issues and records the mode", async () => {
    await setMode("account_required");
    const token = await seedAccountToken();
    const response = await createDownloadUrl(
      downloadRequest({ authorization: `Bearer ${token}` }),
    );
    expect(response.status).toBe(200);

    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "download.issued"))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(row?.details).toMatchObject({ mode: "account_required" });
  });
});

describe("browser download route", () => {
  test("anonymous mode redirects straight to the signed URL", async () => {
    const response = await redirectToDownload(browserRequest(), browserContext);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")?.startsWith(`${PUBLIC_URL}/api/v1/download/`)).toBe(true);
  });

  test("account_required sends a logged-out visitor through the forum login", async () => {
    await setMode("account_required");
    const response = await redirectToDownload(browserRequest(), browserContext);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/api/auth/sforum/start");
    expect(location.searchParams.get("redirect")).toBe(
      "/api/v1/products/gated/download/linux/amd64",
    );
  });

  test("account_required with a session lands on the signed URL", async () => {
    await setMode("account_required");
    const session = await createSession(db, accountId, { ttlSeconds: 3600 });
    sessionCookie = session.token;

    const response = await redirectToDownload(browserRequest(), browserContext);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")?.startsWith(`${PUBLIC_URL}/api/v1/download/`)).toBe(true);
  });
});

describe("settings, health and the seed", () => {
  test("pinning the mode writes the row, audits the flip and reports the source", async () => {
    await setMode("account_required");
    const runtime = await getRuntimeConfig(db, { fresh: true });
    expect(runtime.downloadAuthMode).toBe("account_required");
    expect(runtime.downloadAuthModeSource).toBe("database");

    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "settings.download_auth_mode.changed"))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(row?.actorAdminId).toBe(adminId);
    expect(row?.details).toMatchObject({
      from: "seed:anonymous",
      to: "account_required",
      effective: "account_required",
    });
  });

  test("null means follow the env seed, not pin the default", async () => {
    await saveStoreSettings(
      db,
      {
        publicUrl: PUBLIC_URL,
        downloadTtlSeconds: null,
        downloadMode: null,
        downloadAuthMode: null,
        rateLimits: undefined,
      },
      { adminId, ip: null },
      { requestOrigin: PUBLIC_URL, requestProtocol: "http:", requestHost: "127.0.0.1:3999" },
    );
    resetRuntimeConfigForTests();
    const runtime = await getRuntimeConfig(db, { fresh: true });
    expect(runtime.downloadAuthMode).toBe("anonymous");
    expect(runtime.downloadAuthModeSource).toBe("env");

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "settings.download_auth_mode.changed"));
    expect(rows).toHaveLength(0);
  });

  test("a rejected value never reaches the row", async () => {
    await expect(
      saveStoreSettings(
        db,
        {
          publicUrl: PUBLIC_URL,
          downloadTtlSeconds: null,
          downloadMode: null,
          downloadAuthMode: "required",
          rateLimits: undefined,
        },
        { adminId, ip: null },
        { requestOrigin: PUBLIC_URL, requestProtocol: "http:", requestHost: "127.0.0.1:3999" },
      ),
    ).rejects.toThrow();

    resetRuntimeConfigForTests();
    expect((await getRuntimeConfig(db, { fresh: true })).downloadAuthMode).toBe("anonymous");
  });
});
