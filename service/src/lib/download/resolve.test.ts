import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { PoolClient } from "pg";

import { GET as downloadRoute } from "@/app/api/v1/download/[token]/route";
import { closeDb, getDb, getPool, type Db } from "@/db/client";
import {
  githubRepos,
  products,
  releaseAssets,
  releaseVersions,
  repoReleases,
} from "@/db/schema";
import { TRUNCATE_ALL, TRUNCATE_TABLES } from "@/lib/test-support/db";
import { getConfig, resetConfigForTests } from "@/lib/config";
import { encryptSecret } from "@/lib/crypto";
import { invalidateGithubConfigCache } from "@/lib/github/app-config";
import {
  invalidateRuntimeConfig,
  resetRuntimeConfigForTests,
} from "@/lib/settings/runtime";
import { issueDownloadUrl, type IssueResult } from "./issue";
import { resolveDownloadTarget } from "./resolve";
import { signDownloadToken, type DownloadClaims } from "./token";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

const PUBLIC_URL = "http://127.0.0.1:3999";
const DOWNLOAD_SECRET = "d".repeat(64);
const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
const NOW = 1_700_000_000;
const UPSTREAM_ASSET_ID = 555;

let dbGuard: PoolClient;
let guardOpen = false;

/**
 * Several workers share one test database. Each test holds `ACCESS SHARE` on every table it
 * touches, so a concurrently running suite's `TRUNCATE ... RESTART IDENTITY CASCADE` waits
 * instead of deleting rows mid-assertion. The truncate itself runs on the guarding session,
 * where Postgres may upgrade its own lock; it is committed before the next test starts.
 */
async function resetDatabase(): Promise<void> {
  if (guardOpen) {
    await dbGuard.query("COMMIT");
    guardOpen = false;
  }
  await withRetry(() => dbGuard.query(TRUNCATE_ALL));
  await withRetry(async () => {
    await dbGuard.query("BEGIN");
    // Bounded wait: lock contention with another suite must surface as a retry, not a hang.
    await dbGuard.query("SET LOCAL lock_timeout = '2000ms'");
    try {
      await dbGuard.query(
      `LOCK TABLE ${TRUNCATE_TABLES.join(", ")} IN ACCESS SHARE MODE`,
    );
    } catch (error) {
      await dbGuard.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
  guardOpen = true;
}

/** Lock contention with a concurrent suite is expected and safe to retry. */
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

// Deterministic body so the byte-for-byte check is meaningful without a real ZIP.
const ZIP = new Uint8Array(512);
for (let index = 0; index < ZIP.length; index += 1) ZIP[index] = (index * 7) % 251;
const ZIP_SHA256 = createHash("sha256").update(ZIP).digest("hex");

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let upstreamMode: "ok" | "error" | "redirect" = "ok";
let lastUpstreamAuth: string | null = null;
let repoCounter = 4242;
let releaseCounter = 900;

type ProductStatus =
  | "draft"
  | "pending_review"
  | "published"
  | "rejected"
  | "delisted";
type ReleaseState =
  | "candidate"
  | "pending_review"
  | "published"
  | "rejected"
  | "yanked"
  | "needs_attention";
type Channel = "stable" | "beta";
type UpstreamState = "connected" | "degraded" | "disconnected";

type Product = { id: string; repoId: number | null };

async function createProduct(
  options: {
    slug?: string;
    status?: ProductStatus;
    upstreamState?: UpstreamState | null;
    repoId?: number | null;
    repoPrivate?: boolean;
  } = {},
): Promise<Product> {
  const slug = options.slug ?? "markdown-plus";
  const repoId = options.repoId === undefined ? ++repoCounter : options.repoId;

  if (repoId !== null && options.upstreamState !== null) {
    await db.insert(githubRepos).values({
      repoId,
      installationId: 77,
      fullName: `octo/${slug}`,
      private: options.repoPrivate ?? false,
      upstreamState: options.upstreamState ?? "connected",
    });
  }

  const [row] = await db
    .insert(products)
    .values({
      extensionId: `sforum.${slug}`,
      name: slug,
      kind: "plugin",
      slug,
      status: options.status ?? "published",
      repoId,
    })
    .returning({ id: products.id });

  return { id: row!.id, repoId };
}

async function createVersion(
  product: Product,
  options: {
    version?: string;
    channel?: Channel;
    state?: ReleaseState;
    setLatest?: boolean;
  } = {},
): Promise<{ id: string; version: string }> {
  const version = options.version ?? "1.0.0";
  const channel = options.channel ?? "stable";
  const state = options.state ?? "published";

  const [release] = await db
    .insert(repoReleases)
    .values({
      repoId: product.repoId ?? 1,
      githubReleaseId: ++releaseCounter,
      tag: `v${version}`,
    })
    .returning({ id: repoReleases.id });

  const [row] = await db
    .insert(releaseVersions)
    .values({
      productId: product.id,
      repoReleaseId: release!.id,
      version,
      channel,
      state,
      sforumVersionConstraint: ">=1.0.0",
    })
    .returning({ id: releaseVersions.id });

  const setLatest =
    options.setLatest ?? (channel === "stable" && state === "published");
  if (setLatest) {
    await db
      .update(products)
      .set({ latestStableVersionId: row!.id })
      .where(eq(products.id, product.id));
  }

  return { id: row!.id, version };
}

async function createAsset(
  versionId: string,
  options: {
    os?: string;
    arch?: string;
    filename?: string;
    size?: number;
    sha256?: string;
  } = {},
): Promise<{ id: string }> {
  const [row] = await db
    .insert(releaseAssets)
    .values({
      releaseVersionId: versionId,
      os: options.os ?? "linux",
      arch: options.arch ?? "amd64",
      filename: options.filename ?? "markdown-linux-amd64.zip",
      size: options.size ?? ZIP.length,
      sha256: options.sha256 ?? ZIP_SHA256,
      upstreamAssetId: UPSTREAM_ASSET_ID,
      detectionSource: "header",
    })
    .returning({ id: releaseAssets.id });

  return { id: row!.id };
}

function issue(product = "markdown-plus", version?: string): Promise<IssueResult> {
  return issueDownloadUrl(
    db,
    { product, version: version ?? null, os: "linux", arch: "amd64" },
    {
      secret: DOWNLOAD_SECRET,
      publicUrl: PUBLIC_URL,
      ttlSeconds: 1800,
      now: NOW,
    },
  );
}

function claimsOf(result: IssueResult): DownloadClaims {
  if (!result.ok) throw new Error(`issue failed: ${result.code}`);
  const token = result.body.url.split("/").pop()!;
  const payload = token.split(".")[0]!;
  return JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as DownloadClaims;
}

function download(token: string): Promise<Response> {
  return downloadRoute(new Request(`${PUBLIC_URL}/api/v1/download/${token}`), {
    params: Promise.resolve({ token }),
  });
}

/**
 * `getConfig()` caches the boot-time mode, so flipping it for one test means resetting that
 * cache on both ends — otherwise the next test silently inherits redirect mode.
 */
async function withDownloadMode<T>(
  mode: "proxy" | "redirect",
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env.STORE_DOWNLOAD_MODE;
  process.env.STORE_DOWNLOAD_MODE = mode;
  resetConfigForTests();
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.STORE_DOWNLOAD_MODE;
    else process.env.STORE_DOWNLOAD_MODE = previous;
    resetConfigForTests();
  }
}

/**
 * The route verifies expiry against the real clock, so route tests re-stamp the seeded claims
 * with a live deadline instead of the pinned `NOW` used by the issuer tests.
 */
function liveToken(claims: DownloadClaims): string {
  return signDownloadToken(
    { ...claims, e: Math.floor(Date.now() / 1000) + 1800 },
    DOWNLOAD_SECRET,
  );
}

/** Seed one published product/version/asset and return the claims a link would carry. */
async function seed(
  assetOptions: { filename?: string; sha256?: string } = {},
): Promise<{ claims: DownloadClaims; assetId: string; versionId: string }> {
  const product = await createProduct();
  const version = await createVersion(product);
  const asset = await createAsset(version.id, assetOptions);
  const claims = claimsOf(await issue());

  return { claims, assetId: asset.id, versionId: version.id };
}

/**
 * The App is console configuration now (2026-10-25), so the suite writes the same rows the
 * console would and `fetchUpstreamZip` reads them back through the database, exactly as
 * production does. The RSA key is generated once — 2048-bit keygen per test would dominate the
 * suite's runtime for no extra coverage.
 */
let appPrivateKeyPem = "";

function keyringKid(): string {
  return "k1";
}

async function seedGithubApp(port: number): Promise<void> {
  const keyring = getConfig().keyring;
  const webhookCiphertext = encryptSecret("webhook-secret", keyring);
  const keyCiphertext = encryptSecret(appPrivateKeyPem, keyring);

  await getPool().query("DELETE FROM github_app_config");
  await getPool().query(
    `INSERT INTO github_app_config
       (id, app_id, slug, api_base_url, webhook_secret_ciphertext, webhook_secret_keyring_kid)
     VALUES ('default', 123, 'sforum-store', $1, $2, $3)`,
    [`http://127.0.0.1:${port}`, webhookCiphertext, keyringKid()],
  );
  await getPool().query(
    `INSERT INTO github_app_private_keys
       (config_id, app_key_id, fingerprint, ciphertext, keyring_kid)
     VALUES ('default', 'k1', $1, $2, $3)`,
    ["a".repeat(64), keyCiphertext, keyringKid()],
  );
  invalidateGithubConfigCache();
}

async function clearGithubApp(): Promise<void> {
  await getPool().query("DELETE FROM github_app_config");
  invalidateGithubConfigCache();
}

/**
 * `bun test` runs every file in one process and `getConfig()` caches its first read, so the
 * environment this suite needs must be restored afterwards. An unrestored `STORE_PUBLIC_URL`
 * silently re-points the next suite's derived URLs: `:3999` from here used to leak into
 * `github/app-config.test.ts`, which expects `:3000`.
 */
const ENV_KEYS = [
  "DATABASE_URL",
  "NODE_ENV",
  "STORE_PUBLIC_URL",
  "STORE_SESSION_SECRET",
  "STORE_DOWNLOAD_SECRET",
  "STORE_SECRET_KEYS",
] as const;

const savedEnv = new Map<string, string | undefined>();

function applyTestEnv(): void {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.NODE_ENV = "test";
  process.env.STORE_PUBLIC_URL = PUBLIC_URL;
  process.env.STORE_SESSION_SECRET = "s".repeat(64);
  process.env.STORE_DOWNLOAD_SECRET = DOWNLOAD_SECRET;
  process.env.STORE_SECRET_KEYS = `k1:${Buffer.alloc(32, 3).toString("base64")}`;
}

/** Puts every key back, deleting the ones that were unset before this file ran. */
function restoreTestEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
}

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/access_tokens") && request.method === "POST") {
        return Response.json({
          token: "ghs_test_installation_token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (url.pathname.includes("/releases/assets/")) {
        lastUpstreamAuth = request.headers.get("authorization");
        if (upstreamMode === "error") {
          return Response.json({ message: "upstream exploded" }, { status: 500 });
        }
        if (upstreamMode === "redirect") {
          // Mirrors the live API: 302 to a signed object URL with an empty body.
          return new Response(null, {
            status: 302,
            headers: { location: `/object/${UPSTREAM_ASSET_ID}` },
          });
        }
        return new Response(ZIP, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (url.pathname.startsWith("/object/")) {
        return new Response(ZIP, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  applyTestEnv();
  resetConfigForTests();

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  appPrivateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
  dbGuard = await getPool().connect();
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  // `TRUNCATE_ALL` wipes the App row too; every test starts from a configured store.
  await seedGithubApp(server.port);
  repoCounter = 4242;
  releaseCounter = 900;
  upstreamMode = "ok";
  lastUpstreamAuth = null;
  // `store_settings` is truncated between tests, so a cached runtime config would be stale.
  resetRuntimeConfigForTests();
});

afterAll(async () => {
  try {
    if (guardOpen) await dbGuard.query("COMMIT");
  } finally {
    if (dbGuard) dbGuard.release();
    await closeDb();
    restoreTestEnv();
    // The runtime-settings cache is module state with a 15 s TTL; dropping it here keeps the
    // `:3999` seed from answering the next suite's `getRuntimeConfig` call.
    resetRuntimeConfigForTests();
    resetConfigForTests();
    server.stop(true);
  }
});

describe("resolveDownloadTarget", () => {
  test("returns the upstream coordinates for a live asset", async () => {
    const { claims, assetId } = await seed();

    const resolved = await resolveDownloadTarget(db, claims);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.target).toEqual({
      assetId,
      filename: "markdown-linux-amd64.zip",
      size: ZIP.length,
      sha256: ZIP_SHA256,
      repoFullName: "octo/markdown-plus",
      repoPrivate: false,
      installationId: 77,
      upstreamAssetId: UPSTREAM_ASSET_ID,
    });
  });

  test("410 asset_missing when the asset row is gone", async () => {
    await seed();

    expect(
      await resolveDownloadTarget(db, {
        a: "00000000-0000-4000-8000-000000000000",
        s: ZIP_SHA256,
        e: NOW + 1800,
      }),
    ).toEqual({ ok: false, status: 410, code: "asset_missing" });
  });

  test("410 digest_mismatch when the stored digest changed", async () => {
    const { claims } = await seed();

    expect(
      await resolveDownloadTarget(db, { ...claims, s: OTHER_DIGEST }),
    ).toEqual({ ok: false, status: 410, code: "digest_mismatch" });
  });

  test("410 release_unpublished for a yanked version", async () => {
    const product = await createProduct();
    const version = await createVersion(product);
    const asset = await createAsset(version.id);
    const claims = claimsOf(await issue());

    await db
      .update(releaseVersions)
      .set({ state: "yanked", yankedAt: new Date() })
      .where(eq(releaseVersions.id, version.id));

    expect(await resolveDownloadTarget(db, claims)).toEqual({
      ok: false,
      status: 410,
      code: "release_unpublished",
    });
    expect(claims.a).toBe(asset.id);
  });

  test("410 release_unpublished for any non-published state", async () => {
    const product = await createProduct();
    const version = await createVersion(product);
    await createAsset(version.id);
    const claims = claimsOf(await issue());

    for (const state of ["needs_attention", "pending_review"] as const) {
      await db
        .update(releaseVersions)
        .set({ state })
        .where(eq(releaseVersions.id, version.id));
      expect(await resolveDownloadTarget(db, claims)).toEqual({
        ok: false,
        status: 410,
        code: "release_unpublished",
      });
    }
  });

  test("410 product_unpublished for a delisted product", async () => {
    const { claims } = await seed();
    await db
      .update(products)
      .set({ status: "delisted" })
      .where(eq(products.slug, "markdown-plus"));

    expect(await resolveDownloadTarget(db, claims)).toEqual({
      ok: false,
      status: 410,
      code: "product_unpublished",
    });
  });

  test("410 upstream_disconnected when the repo is disconnected", async () => {
    const product = await createProduct({ upstreamState: "connected" });
    const version = await createVersion(product);
    await createAsset(version.id);
    const claims = claimsOf(await issue());

    await db
      .update(githubRepos)
      .set({ upstreamState: "disconnected" })
      .where(eq(githubRepos.repoId, product.repoId!));

    expect(await resolveDownloadTarget(db, claims)).toEqual({
      ok: false,
      status: 410,
      code: "upstream_disconnected",
    });
  });

  test("410 upstream_disconnected when the repo row is missing", async () => {
    const product = await createProduct({ repoId: null });
    const version = await createVersion(product);
    await createAsset(version.id);
    const claims = claimsOf(await issue());

    expect(await resolveDownloadTarget(db, claims)).toEqual({
      ok: false,
      status: 410,
      code: "upstream_disconnected",
    });
  });

  test("503 upstream_degraded while the installation is suspended", async () => {
    const product = await createProduct({ upstreamState: "degraded" });
    const version = await createVersion(product);
    await createAsset(version.id);
    const claims = claimsOf(await issue());

    expect(await resolveDownloadTarget(db, claims)).toEqual({
      ok: false,
      status: 503,
      code: "upstream_degraded",
    });
  });

  test("checks in order: release state before upstream state", async () => {
    const product = await createProduct({ upstreamState: "disconnected" });
    const version = await createVersion(product, { state: "yanked" });
    const asset = await createAsset(version.id);
    // A yanked release is not issuable, so sign the claims by hand.
    const claims = { a: asset.id, s: ZIP_SHA256, e: NOW + 1800 };

    expect(await resolveDownloadTarget(db, claims)).toEqual({
      ok: false,
      status: 410,
      code: "release_unpublished",
    });
  });

  test("checks in order: product state before upstream state", async () => {
    const product = await createProduct();
    const version = await createVersion(product);
    await createAsset(version.id);
    const claims = claimsOf(await issue());

    await db
      .update(products)
      .set({ status: "delisted" })
      .where(eq(products.id, product.id));
    await db
      .update(githubRepos)
      .set({ upstreamState: "disconnected" })
      .where(eq(githubRepos.repoId, product.repoId!));

    expect(await resolveDownloadTarget(db, claims)).toEqual({
      ok: false,
      status: 410,
      code: "product_unpublished",
    });
  });

  test("keeps a v1 link alive after v2 is published", async () => {
    const product = await createProduct();
    const first = await createVersion(product, { version: "1.0.0" });
    const firstAsset = await createAsset(first.id, {
      filename: "markdown-v1-linux-amd64.zip",
    });
    const v1Claims = claimsOf(await issue());
    expect(v1Claims.a).toBe(firstAsset.id);

    // Publishing v2 moves the materialised "latest" pointer, exactly like the dashboard does.
    const second = await createVersion(product, { version: "2.0.0" });
    const secondAsset = await createAsset(second.id, {
      filename: "markdown-v2-linux-amd64.zip",
      sha256: OTHER_DIGEST,
    });
    expect(claimsOf(await issue()).a).toBe(secondAsset.id);

    const resolved = await resolveDownloadTarget(db, v1Claims);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.target.filename).toBe("markdown-v1-linux-amd64.zip");
      expect(resolved.target.sha256).toBe(ZIP_SHA256);
    }
  });
});

describe("GET /api/v1/download/{token}", () => {
  test("streams the upstream ZIP with the store's own headers", async () => {
    const { claims } = await seed({ filename: 'weird"name.zip' });
    const token = liveToken(claims);

    const response = await download(token);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-length")).toBe(String(ZIP.length));
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="weirdname.zip"',
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    const headers = JSON.stringify([...response.headers]);
    expect(headers).not.toContain("github");
    expect(response.headers.get("location")).toBeNull();

    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.length).toBe(ZIP.length);
    expect(Buffer.from(body).equals(Buffer.from(ZIP))).toBe(true);

    // The upstream call used the installation token, not a PAT or a browser URL.
    expect(lastUpstreamAuth).toBe("Bearer ghs_test_installation_token");
  });

  test("strips non-ASCII and control characters from the filename", async () => {
    const { claims } = await seed({ filename: "插件\r\n.zip" });
    const token = liveToken(claims);

    const response = await download(token);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="__.zip"',
    );
  });

  test("follows the upstream 302 to the signed object URL", async () => {
    const { claims } = await seed();
    upstreamMode = "redirect";

    try {
      const response = await download(liveToken(claims));
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(ZIP))).toBe(
        true,
      );
    } finally {
      upstreamMode = "ok";
    }
  });

  test("410 token_invalid for a tampered token", async () => {
    const { claims } = await seed();
    const token = liveToken(claims);
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    const response = await download(tampered);

    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      code: "token_invalid",
      message: "token_invalid",
    });
  });

  test("410 token_expired for a stale token", async () => {
    const { claims } = await seed();
    const token = signDownloadToken({ ...claims, e: 1 }, DOWNLOAD_SECRET);

    const response = await download(token);

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      code: "token_expired",
      message: "token_expired",
    });
  });

  test("410 with the resolver's code when the release was yanked", async () => {
    const { claims, versionId } = await seed();
    await db
      .update(releaseVersions)
      .set({ state: "yanked" })
      .where(eq(releaseVersions.id, versionId));

    const response = await download(liveToken(claims));

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      code: "release_unpublished",
      message: "release_unpublished",
    });
  });

  test("503 upstream_degraded uses the resolver's status", async () => {
    const product = await createProduct({ upstreamState: "degraded" });
    const version = await createVersion(product);
    await createAsset(version.id);
    const claims = claimsOf(await issue());

    const response = await download(liveToken(claims));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "upstream_degraded",
      message: "upstream_degraded",
    });
  });

  test("503 upstream_unavailable when the upstream fails", async () => {
    const { claims } = await seed();
    upstreamMode = "error";
    const error = spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await download(liveToken(claims));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        code: "upstream_unavailable",
        message: "upstream_unavailable",
      });
    } finally {
      error.mockRestore();
      upstreamMode = "ok";
    }
  });

  test("503 github_config_unreadable when the stored App cannot be decrypted", async () => {
    const { claims } = await seed();
    const token = liveToken(claims);

    // A ciphertext whose keyring kid no longer exists — the shape a rotation accident leaves.
    await getPool().query(
      "UPDATE github_app_config SET webhook_secret_ciphertext = 'v1:gone:AAAA:BBBB:CCCC'",
    );
    invalidateGithubConfigCache();
    try {
      const response = await download(token);
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe("github_config_unreadable");
    } finally {
      await seedGithubApp(server.port);
    }
  });

  test("503 github_not_configured when no App is configured", async () => {
    const { claims } = await seed();
    const token = liveToken(claims);

    await clearGithubApp();
    try {
      const response = await download(token);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        code: "github_not_configured",
        message: "github_not_configured",
      });
    } finally {
      await seedGithubApp(server.port);
    }
  });

  test("redirect mode answers 302 at the signed object URL for a public repository", async () => {
    const { claims } = await seed();
    const token = liveToken(claims);
    upstreamMode = "redirect";

    try {
      const response = await withDownloadMode("redirect", () => download(token));

      expect(response.status).toBe(302);
      expect(response.body).toBeNull();
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("location")).toBe(
        `http://127.0.0.1:${server.port}/object/${UPSTREAM_ASSET_ID}`,
      );
      // Only the upstream object URL leaves; the store's own short link is never echoed.
      expect(response.headers.get("location")).not.toContain(PUBLIC_URL);
      // GitHub was still called with the installation token, not a browser URL or a PAT.
      expect(lastUpstreamAuth).toBe("Bearer ghs_test_installation_token");
    } finally {
      upstreamMode = "ok";
    }
  });

  test("redirect mode falls back to the proxy when GitHub streams the asset itself", async () => {
    const { claims } = await seed();
    // `upstreamMode = "ok"` is GitHub answering 200 with the bytes: no address to hand out.
    const response = await withDownloadMode("redirect", () =>
      download(liveToken(claims)),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(
      Buffer.from(await response.arrayBuffer()).equals(Buffer.from(ZIP)),
    ).toBe(true);
  });

  test("a console-saved mode overrides the STORE_DOWNLOAD_MODE seed", async () => {
    const { claims } = await seed();
    // The env seed in this suite is unset (= proxy); the row says otherwise, and the row wins.
    await getPool().query(
      "INSERT INTO store_settings (id, download_mode) VALUES ('default', 'redirect')",
    );
    invalidateRuntimeConfig();
    upstreamMode = "redirect";

    try {
      const response = await download(liveToken(claims));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("/object/");
    } finally {
      upstreamMode = "ok";
      await getPool().query("DELETE FROM store_settings");
      invalidateRuntimeConfig();
    }
  });

  test("redirect mode keeps proxying a private repository", async () => {
    const product = await createProduct({ repoPrivate: true });
    const version = await createVersion(product);
    await createAsset(version.id);
    const claims = claimsOf(await issue());
    upstreamMode = "redirect";

    try {
      const response = await withDownloadMode("redirect", () =>
        download(liveToken(claims)),
      );

      // A private repository's object URL names the repository and the tag, so the bytes
      // must keep flowing through the store.
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(
        Buffer.from(await response.arrayBuffer()).equals(Buffer.from(ZIP)),
      ).toBe(true);
    } finally {
      upstreamMode = "ok";
    }
  });

  test("redirect mode still refuses a yanked release before answering", async () => {
    const product = await createProduct();
    const version = await createVersion(product);
    await createAsset(version.id);
    const claims = claimsOf(await issue());

    await db
      .update(releaseVersions)
      .set({ state: "yanked" })
      .where(eq(releaseVersions.id, version.id));

    const response = await withDownloadMode("redirect", () =>
      download(liveToken(claims)),
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      code: "release_unpublished",
      message: "release_unpublished",
    });
  });
});
