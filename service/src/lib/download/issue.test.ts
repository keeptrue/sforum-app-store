import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { PoolClient } from "pg";

import { GET as redirectToDownload } from "@/app/api/v1/products/[slug]/download/[os]/[arch]/route";
import { POST as createDownloadUrl } from "@/app/api/v1/download-urls/route";
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
import { resetRuntimeConfigForTests } from "@/lib/settings/runtime";
import { DEFAULT_DOWNLOAD_TTL_SECONDS } from "@/lib/settings/validate";
import { issueDownloadUrl } from "./issue";
import { verifyDownloadToken } from "./token";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

const PUBLIC_URL = "http://127.0.0.1:3999";
const DOWNLOAD_SECRET = "d".repeat(64);
const DIGEST = "a".repeat(64);
const NOW = 1_700_000_000;

let db: Db;
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
  } = {},
): Promise<Product> {
  const slug = options.slug ?? "markdown-plus";
  const repoId = options.repoId === undefined ? ++repoCounter : options.repoId;

  if (repoId !== null && options.upstreamState !== null) {
    await db.insert(githubRepos).values({
      repoId,
      installationId: 77,
      fullName: `octo/${slug}`,
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
      size: options.size ?? 512,
      sha256: options.sha256 ?? DIGEST,
      upstreamAssetId: 555,
      detectionSource: "header",
    })
    .returning({ id: releaseAssets.id });

  return { id: row!.id };
}

function deps(overrides: { now?: number; ttlSeconds?: number } = {}) {
  return {
    secret: DOWNLOAD_SECRET,
    publicUrl: PUBLIC_URL,
    ttlSeconds: overrides.ttlSeconds ?? 1800,
    now: overrides.now ?? NOW,
  };
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
  applyTestEnv();

  resetConfigForTests();

  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
  dbGuard = await getPool().connect();
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  repoCounter = 4242;
  releaseCounter = 900;
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
  }
});

describe("issueDownloadUrl", () => {
  test("signs the latest stable asset for the requested platform", async () => {
    const product = await createProduct();
    const version = await createVersion(product);
    const asset = await createAsset(version.id);

    const result = await issueDownloadUrl(
      db,
      { product: "markdown-plus", os: "linux", arch: "amd64" },
      deps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.body.url).toBe(
      `${PUBLIC_URL}/api/v1/download/${result.body.url.split("/").pop()}`,
    );
    expect(result.body.sha256).toBe(DIGEST);
    expect(result.body.size).toBe(512);
    expect(result.body.expiresAt).toBe(
      new Date((NOW + 1800) * 1000).toISOString(),
    );

    const token = result.body.url.slice(`${PUBLIC_URL}/api/v1/download/`.length);
    const verified = verifyDownloadToken(token, DOWNLOAD_SECRET, NOW);
    expect(verified).toEqual({
      ok: true,
      claims: { a: asset.id, s: DIGEST, e: NOW + 1800 },
    });
  });

  test("never exposes the upstream host in the issued URL", async () => {
    const product = await createProduct();
    const version = await createVersion(product);
    await createAsset(version.id);

    const result = await issueDownloadUrl(
      db,
      { product: "markdown-plus", os: "linux", arch: "amd64" },
      deps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.url).not.toContain("github.com");
    expect(result.body.url).not.toContain("githubusercontent");
    expect(result.body.url).not.toContain("browser_download_url");
    expect(JSON.stringify(result.body)).not.toContain("github");
  });

  test("honours an explicit version instead of the latest", async () => {
    const product = await createProduct();
    const first = await createVersion(product, { version: "1.0.0" });
    const firstAsset = await createAsset(first.id, { sha256: DIGEST });
    await createVersion(product, { version: "1.1.0" });

    const result = await issueDownloadUrl(
      db,
      {
        product: "markdown-plus",
        version: "1.0.0",
        os: "linux",
        arch: "amd64",
      },
      deps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const token = result.body.url.split("/").pop()!;
    const verified = verifyDownloadToken(token, DOWNLOAD_SECRET, NOW);
    expect(verified.ok && verified.claims.a).toBe(firstAsset.id);
  });

  test("rejects a draft product with product_not_found", async () => {
    const product = await createProduct({ status: "draft" });
    const version = await createVersion(product);
    await createAsset(version.id);

    expect(
      await issueDownloadUrl(
        db,
        { product: "markdown-plus", os: "linux", arch: "amd64" },
        deps(),
      ),
    ).toEqual({ ok: false, status: 404, code: "product_not_found" });
  });

  test("rejects an unknown slug with product_not_found", async () => {
    expect(
      await issueDownloadUrl(
        db,
        { product: "nope", os: "linux", arch: "amd64" },
        deps(),
      ),
    ).toEqual({ ok: false, status: 404, code: "product_not_found" });
  });

  test("treats a disconnected upstream as not issuable", async () => {
    const product = await createProduct({ upstreamState: "disconnected" });
    const version = await createVersion(product);
    await createAsset(version.id);

    expect(
      await issueDownloadUrl(
        db,
        { product: "markdown-plus", os: "linux", arch: "amd64" },
        deps(),
      ),
    ).toEqual({ ok: false, status: 404, code: "product_not_found" });
  });

  test("still issues while the upstream is degraded", async () => {
    const product = await createProduct({ upstreamState: "degraded" });
    const version = await createVersion(product);
    await createAsset(version.id);

    const result = await issueDownloadUrl(
      db,
      { product: "markdown-plus", os: "linux", arch: "amd64" },
      deps(),
    );
    // Degraded is recoverable (Q2): the catalog keeps the product, the proxy answers 503.
    expect(result.ok).toBe(true);
  });

  test("still issues when the product has no repo row at all", async () => {
    const product = await createProduct({ repoId: null });
    const version = await createVersion(product);
    await createAsset(version.id);

    const result = await issueDownloadUrl(
      db,
      { product: "markdown-plus", os: "linux", arch: "amd64" },
      deps(),
    );
    // A missing repo row is not "disconnected"; only an explicit disconnect blocks issuing.
    expect(result.ok).toBe(true);
  });

  test("rejects an unknown version with release_not_found", async () => {
    const product = await createProduct();
    const version = await createVersion(product);
    await createAsset(version.id);

    expect(
      await issueDownloadUrl(
        db,
        {
          product: "markdown-plus",
          version: "9.9.9",
          os: "linux",
          arch: "amd64",
        },
        deps(),
      ),
    ).toEqual({ ok: false, status: 404, code: "release_not_found" });
  });

  test("rejects a yanked version with release_not_found", async () => {
    const product = await createProduct();
    const version = await createVersion(product, {
      version: "1.0.0",
      state: "yanked",
    });
    await createAsset(version.id);

    expect(
      await issueDownloadUrl(
        db,
        {
          product: "markdown-plus",
          version: "1.0.0",
          os: "linux",
          arch: "amd64",
        },
        deps(),
      ),
    ).toEqual({ ok: false, status: 404, code: "release_not_found" });
  });

  test("reports no_stable_release when only a beta is published", async () => {
    const product = await createProduct();
    const version = await createVersion(product, {
      version: "2.0.0-beta.1",
      channel: "beta",
    });
    await createAsset(version.id);

    expect(
      await issueDownloadUrl(
        db,
        { product: "markdown-plus", os: "linux", arch: "amd64" },
        deps(),
      ),
    ).toEqual({ ok: false, status: 404, code: "no_stable_release" });
  });

  test("reports no_stable_release when the latest pointer is stale", async () => {
    const product = await createProduct();
    const version = await createVersion(product, { version: "1.0.0" });
    await createAsset(version.id);
    await db
      .update(releaseVersions)
      .set({ state: "yanked", yankedAt: new Date() })
      .where(eq(releaseVersions.id, version.id));

    expect(
      await issueDownloadUrl(
        db,
        { product: "markdown-plus", os: "linux", arch: "amd64" },
        deps(),
      ),
    ).toEqual({ ok: false, status: 404, code: "no_stable_release" });
  });

  test("treats a present-but-empty version as a lookup, not as the latest", async () => {
    const product = await createProduct();
    const version = await createVersion(product);
    await createAsset(version.id);

    // Only an *absent* version means "latest stable"; an empty string is a bad lookup.
    expect(
      await issueDownloadUrl(
        db,
        { product: "markdown-plus", version: "", os: "linux", arch: "amd64" },
        deps(),
      ),
    ).toEqual({ ok: false, status: 404, code: "release_not_found" });
    expect(
      await issueDownloadUrl(
        db,
        { product: "markdown-plus", os: "linux", arch: "amd64" },
        deps(),
      ),
    ).toEqual(expect.objectContaining({ ok: true }));
  });

  test("rejects a platform the release does not carry", async () => {
    const product = await createProduct();
    const version = await createVersion(product);
    await createAsset(version.id, { os: "linux", arch: "amd64" });

    expect(
      await issueDownloadUrl(
        db,
        { product: "markdown-plus", os: "darwin", arch: "arm64" },
        deps(),
      ),
    ).toEqual({ ok: false, status: 404, code: "asset_not_found" });
  });

  test("rejects an empty or overlong os/arch with invalid_body", async () => {
    const product = await createProduct();
    const version = await createVersion(product);
    await createAsset(version.id);

    const cases = [
      { os: "", arch: "amd64" },
      { os: "linux", arch: "" },
      { os: "   ", arch: "amd64" },
      { os: "linux", arch: "a".repeat(33) },
      { os: "a".repeat(33), arch: "amd64" },
    ];
    for (const platform of cases) {
      expect(
        await issueDownloadUrl(
          db,
          { product: "markdown-plus", ...platform },
          deps(),
        ),
      ).toEqual({ ok: false, status: 400, code: "invalid_body" });
    }
  });

  test("keeps the token TTL ahead of the install-intent window", () => {
    // Q5 invariant: token_ttl > intent_ttl (900s) + fetch_timeout (90s) + clock skew (60s).
    // The value is console-tunable now, so the invariant is asserted on the default that a
    // fresh deployment starts from (`store_settings.download_ttl_seconds` may raise it, and
    // the console's own bounds keep it inside the same window).
    expect(DEFAULT_DOWNLOAD_TTL_SECONDS).toBe(30 * 60);
    expect(DEFAULT_DOWNLOAD_TTL_SECONDS).toBeGreaterThan(900 + 90 + 60);
  });
});

describe("POST /api/v1/download-urls", () => {
  function request(body: unknown): Request {
    return new Request(`${PUBLIC_URL}/api/v1/download-urls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  test("issues anonymously, without a session or cookie", async () => {
    const product = await createProduct();
    const version = await createVersion(product);
    await createAsset(version.id);

    const response = await createDownloadUrl(
      request({ product: "markdown-plus", os: "linux", arch: "amd64" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("set-cookie")).toBeNull();

    const body = (await response.json()) as {
      url: string;
      sha256: string;
      size: number;
      expiresAt: string;
    };
    expect(body.url.startsWith(`${PUBLIC_URL}/api/v1/download/`)).toBe(true);
    expect(body.url).not.toContain("github.com");
    expect(body.sha256).toBe(DIGEST);
    expect(body.size).toBe(512);
    expect(Number.isNaN(Date.parse(body.expiresAt))).toBe(false);
  });

  test("rejects malformed JSON with invalid_body", async () => {
    const response = await createDownloadUrl(request("{not json"));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      code: "invalid_body",
      message: "invalid_body",
    });
  });

  test("requires product, os and arch strings", async () => {
    const bodies = [
      { os: "linux", arch: "amd64" },
      { product: "markdown-plus", arch: "amd64" },
      { product: "markdown-plus", os: "linux" },
      { product: 7, os: "linux", arch: "amd64" },
      { product: "markdown-plus", os: "linux", arch: "amd64", version: 3 },
      [1, 2, 3],
      null,
    ];

    for (const body of bodies) {
      const response = await createDownloadUrl(request(body));
      expect(response.status).toBe(400);
      expect((await response.json()) as { code: string }).toEqual({
        code: "invalid_body",
        message: "invalid_body",
      });
    }
  });

  test("maps a missing product to a 404 error body", async () => {
    const response = await createDownloadUrl(
      request({ product: "nope", os: "linux", arch: "amd64" }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "product_not_found",
      message: "product_not_found",
    });
  });

  test("accepts an explicit version", async () => {
    const product = await createProduct();
    const version = await createVersion(product, { version: "1.0.0" });
    await createAsset(version.id);

    const response = await createDownloadUrl(
      request({
        product: "markdown-plus",
        version: "1.0.0",
        os: "linux",
        arch: "amd64",
      }),
    );

    expect(response.status).toBe(200);
  });
});

describe("GET /api/v1/products/{slug}/download/{os}/{arch}", () => {
  function context(slug: string, os: string, arch: string) {
    return { params: Promise.resolve({ slug, os, arch }) };
  }

  test("redirects to the same signed URL the issuer produces", async () => {
    const product = await createProduct();
    const version = await createVersion(product);
    await createAsset(version.id);

    const response = await redirectToDownload(
      new Request(`${PUBLIC_URL}/api/v1/products/markdown-plus/download/linux/amd64`),
      context("markdown-plus", "linux", "amd64"),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.body).toBeNull();

    const location = response.headers.get("location");
    expect(location?.startsWith(`${PUBLIC_URL}/api/v1/download/`)).toBe(true);
    expect(location).not.toContain("github.com");

    const token = location!.split("/").pop()!;
    const verified = verifyDownloadToken(token, DOWNLOAD_SECRET);
    expect(verified.ok).toBe(true);
  });

  test("returns 404 for a product that is not published", async () => {
    const product = await createProduct({ status: "delisted" });
    const version = await createVersion(product);
    await createAsset(version.id);

    const response = await redirectToDownload(
      new Request(`${PUBLIC_URL}/api/v1/products/markdown-plus/download/linux/amd64`),
      context("markdown-plus", "linux", "amd64"),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "product_not_found",
      message: "product_not_found",
    });
  });
});
