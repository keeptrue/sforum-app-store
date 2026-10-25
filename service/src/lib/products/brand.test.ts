import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import {
  accounts,
  assets,
  githubAppConfig,
  githubAppPrivateKeys,
  githubRepos,
  products,
} from "@/db/schema";
import {
  getConfig,
  resetConfigForTests,
  type StoreConfig,
} from "@/lib/config";
import { encryptSecret } from "@/lib/crypto";
import { invalidateGithubConfigCache } from "@/lib/github/app-config";
import { GithubError } from "@/lib/github/client";
import {
  BRAND_ICON_PATH,
  BRAND_SOCIAL_PATH,
  MANIFEST_FILE,
  type BrandFileReader,
} from "@/lib/github/brand";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import { LocalAssetStore } from "@/lib/storage/local";
import { refreshProductBrand } from "./brand";

/**
 * The brand pipeline: `brand/icon.png` first, GitHub's social preview second, the previous
 * mark when both fail.
 *
 * The interesting cases are all about *degradation*, not the happy path: a repository that
 * never adopted the brand layout, a square-shaped contract violated by one axis, a GitHub
 * outage during a refresh. Each must leave a picture on screen and explain itself on the row.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

const REPO = 6_242;
const INSTALL = 99;
const REPO_PAGE = "https://github.com/acme/markdown-plus";
const OG_IMAGE = "https://repository-images.githubusercontent.com/4242/abcdef";
const NOW = new Date("2026-10-25T02:00:00Z");

/** 2×2 and 4×2 PNGs, built by a 12-line encoder so the bytes are real PNGs. */
const PNG_SQUARE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR42mOQz3/9H4QZYAwAUroJ4dYFkQEAAAAASUVORK5CYII=",
  "base64",
);
const PNG_WIDE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAEklEQVR42mOQz3/9HxkzoAsAAEOBE8GlKlbwAAAAAElFTkSuQmCC",
  "base64",
);
/** 6×2: a 3:1 card, refused by the ratio gate while staying a valid PNG. */
const PNG_ODD_RATIO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAYAAAACCAYAAAB7Xa1eAAAAEklEQVR42mOQz3/9HxtmwCUBANJIHaFVnNTzAAAAAElFTkSuQmCC",
  "base64",
);

const shaOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const SQUARE_SHA = shaOf(PNG_SQUARE);
const WIDE_SHA = shaOf(PNG_WIDE);

let db: Db;
let config: StoreConfig;
let root: string;
let ownerId: string;
let productId: string;

type FakeFile = { kind: "bytes"; sha: string; bytes: Buffer } | { kind: "error"; status: number };

/**
 * A reader that answers per path, and records every call so refusals can be asserted.
 *
 * `tree` models `GET /git/trees?recursive=1`: the paths a repository layout lookup would see.
 * Omit it and the listing "fails", which is the pre-layout behaviour (assume root).
 */
function fakeReader(
  files: Record<string, FakeFile>,
  options: { tree?: { paths: string[]; truncated?: boolean } | null } = {},
) {
  const calls: Array<{ path: string; ref: string | null }> = [];
  let trees = 0;
  const client = {
    async getRepoFile(
      _fullName: string,
      _installationId: number,
      path: string,
      requestOptions: { ref?: string | null; maxBytes: number },
    ) {
      calls.push({ path, ref: requestOptions.ref ?? null });
      const entry = files[path];
      if (!entry) throw new GithubError(404, "Not Found");
      if (entry.kind === "error") throw new GithubError(entry.status, "boom");
      return { sha: entry.sha, bytes: entry.bytes };
    },
    async listRepoTree() {
      trees += 1;
      if (!options.tree) throw new GithubError(500, "tree unavailable");
      return {
        entries: options.tree.paths.map((path) => ({
          path,
          type: path.endsWith("/") ? "tree" : "blob",
        })),
        truncated: options.tree.truncated ?? false,
      };
    },
  };
  return {
    client: client as unknown as BrandFileReader,
    calls,
    get trees() {
      return trees;
    },
  };
}

/** A manifest blob whose `id` is the given extension. */
function manifest(id: string): FakeFile {
  return {
    kind: "bytes",
    sha: `blob-manifest-${id}`,
    bytes: Buffer.from(JSON.stringify({ id, name: "x", version: "1.0.0" })),
  };
}

type FetchOverrides = {
  og?: string | null;
  pageStatus?: number;
  imageBytes?: Buffer;
};

/** The social-preview fallback: repository page HTML, then the preview URL. */
function fakeFetch(overrides: FetchOverrides = {}) {
  const calls: string[] = [];
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    if (url === REPO_PAGE) {
      if (overrides.pageStatus !== undefined) {
        return new Response("nope", { status: overrides.pageStatus });
      }
      const og = overrides.og === undefined ? OG_IMAGE : overrides.og;
      const html =
        og === null
          ? "<html><head><title>acme/markdown-plus</title></head></html>"
          : `<html><head><meta property="og:image" content="${og}"></head></html>`;
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url === OG_IMAGE) {
      return new Response(overrides.imageBytes ?? PNG_WIDE, { status: 200 });
    }
    return new Response("unexpected request", { status: 500 });
  };
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}

async function productRow() {
  const [row] = await db.select().from(products).where(eq(products.id, productId));
  return row ?? null;
}

async function seedGithubConfig(apiBaseUrl = "https://api.github.com") {
  const secret = encryptSecret("w".repeat(32), config.keyring);
  await db.insert(githubAppConfig).values({
    id: "default",
    appId: 123,
    slug: "sforum-store",
    apiBaseUrl,
    webhookSecretCiphertext: secret,
    webhookSecretKeyringKid: secret.split(".")[1] ?? "test1",
  });
  const key = encryptSecret(
    "-----BEGIN PRIVATE KEY-----\nnot-used-by-this-path\n-----END PRIVATE KEY-----",
    config.keyring,
  );
  await db.insert(githubAppPrivateKeys).values({
    configId: "default",
    appKeyId: "brand-test-key",
    fingerprint: "SHA256:brand-test",
    ciphertext: key,
    keyringKid: key.split(".")[1] ?? "test1",
  });
  invalidateGithubConfigCache();
}

async function resetGithubConfig(apiBaseUrl: string) {
  await db.delete(githubAppPrivateKeys);
  await db.delete(githubAppConfig);
  await seedGithubConfig(apiBaseUrl);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sforum-brand-test-"));

  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.STORE_PUBLIC_URL = "http://127.0.0.1:3000";
  process.env.STORE_SESSION_SECRET = "s".repeat(64);
  process.env.STORE_DOWNLOAD_SECRET = "d".repeat(64);
  process.env.STORE_SECRET_KEYS = `test1:${Buffer.alloc(32, 5).toString("base64")}`;
  process.env.STORE_ASSET_DIR = root;
  resetConfigForTests();
  config = getConfig();

  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
});

beforeEach(async () => {
  await getPool().query(TRUNCATE_ALL);
  invalidateGithubConfigCache();

  const [account] = await db
    .insert(accounts)
    .values({ issuerKey: "test", sub: "owner", username: "owner" })
    .returning({ id: accounts.id });
  ownerId = account!.id;

  await db.insert(githubRepos).values({
    repoId: REPO,
    installationId: INSTALL,
    fullName: "acme/markdown-plus",
    defaultBranch: "main",
  });

  const [product] = await db
    .insert(products)
    .values({
      extensionId: "sforum.markdown-plus",
      name: "Markdown Plus",
      kind: "plugin",
      slug: "markdown-plus",
      ownerAccountId: ownerId,
      repoId: REPO,
      status: "published",
      defaultLocale: "zh-CN",
    })
    .returning({ id: products.id });
  productId = product!.id;

  await seedGithubConfig();
});

afterAll(async () => {
  await closeDb();
  await rm(root, { recursive: true, force: true });
});

describe("refreshProductBrand: icon", () => {
  test("brand/icon.png is read from the default branch and becomes the mark", async () => {
    const { client, calls } = fakeReader({
      [BRAND_ICON_PATH]: { kind: "bytes", sha: "blob-icon", bytes: PNG_SQUARE },
    });
    const { fetchImpl, calls: fetches } = fakeFetch();

    const result = await refreshProductBrand(db, {
      productId,
      client,
      fetchImpl,
      now: () => NOW,
    });

    expect(result.icon).toEqual({
      ok: true,
      source: "brand_icon",
      sha256: SQUARE_SHA,
      fetchedAt: NOW.toISOString(),
      note: null,
      reason: null,
      changed: true,
    });
    // The ref is the branch head, not a tag: brand assets describe the product.
    expect(calls).toContainEqual({ path: BRAND_ICON_PATH, ref: "main" });
    // Social preview is the fallback, so a working brand icon must not touch the web host.
    expect(fetches).toEqual([]);

    const product = await productRow();
    expect(product).toMatchObject({
      previewSource: "brand_icon",
      previewBlobSha: "blob-icon",
      previewSha256: SQUARE_SHA,
      previewNote: null,
      previewError: null,
    });
    expect(product?.previewFetchedAt?.toISOString()).toBe(NOW.toISOString());

    const stored = await new LocalAssetStore(root).read(LocalAssetStore.key(SQUARE_SHA));
    expect(stored?.equals(PNG_SQUARE)).toBe(true);
  });

  test("an unchanged blob sha costs no download and reports no change", async () => {
    const files = {
      [BRAND_ICON_PATH]: { kind: "bytes" as const, sha: "blob-icon", bytes: PNG_SQUARE },
    };
    await refreshProductBrand(db, { productId, ...fakeReader(files), now: () => NOW });

    const later = new Date(NOW.getTime() + 60_000);
    const result = await refreshProductBrand(db, {
      productId,
      ...fakeReader(files),
      now: () => later,
    });

    expect(result.icon).toMatchObject({ ok: true, changed: false, sha256: SQUARE_SHA });
    expect((await productRow())?.previewFetchedAt?.toISOString()).toBe(later.toISOString());
    const rows = await db.select().from(assets).where(eq(assets.sha256, SQUARE_SHA));
    expect(rows).toHaveLength(1);
  });

  test("a 4×2 icon is refused as not square and falls back to the social preview", async () => {
    const { client } = fakeReader({
      [BRAND_ICON_PATH]: { kind: "bytes", sha: "blob-wide", bytes: PNG_WIDE },
    });
    const { fetchImpl } = fakeFetch();

    const result = await refreshProductBrand(db, {
      productId,
      client,
      fetchImpl,
      now: () => NOW,
    });

    expect(result.icon).toMatchObject({
      ok: true,
      source: "social_preview",
      sha256: WIDE_SHA,
      note: "brand_not_square",
      reason: null,
    });
    const product = await productRow();
    expect(product).toMatchObject({
      previewSource: "social_preview",
      previewNote: "brand_not_square",
      previewError: null,
      previewBlobSha: null,
    });
  });

  test("a repository without brand/ says nothing and uses the fallback", async () => {
    const { client } = fakeReader({});
    const result = await refreshProductBrand(db, {
      productId,
      client,
      ...fakeFetch(),
      now: () => NOW,
    });

    expect(result.icon).toMatchObject({ ok: true, source: "social_preview", note: null });
    expect((await productRow())?.previewNote).toBeNull();
  });

  test("a 413 from the contents API is reported as too large, not as a crash", async () => {
    const { client } = fakeReader({
      [BRAND_ICON_PATH]: { kind: "error", status: 413 },
    });
    const result = await refreshProductBrand(db, {
      productId,
      client,
      ...fakeFetch(),
      now: () => NOW,
    });

    expect(result.icon).toMatchObject({
      ok: true,
      source: "social_preview",
      note: "brand_too_large",
    });
  });

  test("markup renamed to .png never reaches the asset store", async () => {
    const { client } = fakeReader({
      [BRAND_ICON_PATH]: {
        kind: "bytes",
        sha: "blob-svg",
        bytes: Buffer.from('<svg onload="alert(1)"></svg>'),
      },
    });
    const { fetchImpl } = fakeFetch();

    const result = await refreshProductBrand(db, {
      productId,
      client,
      fetchImpl,
      now: () => NOW,
    });

    expect(result.icon).toMatchObject({ source: "social_preview", note: "brand_not_png" });
    const rows = await db.select().from(assets);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mime).toBe("image/png");
  });

  test("both sources failing keeps the previous mark and records the reason", async () => {
    await refreshProductBrand(db, {
      productId,
      ...fakeReader({
        [BRAND_ICON_PATH]: { kind: "bytes", sha: "blob-icon", bytes: PNG_SQUARE },
      }),
      now: () => NOW,
    });
    const before = await productRow();

    const second = await refreshProductBrand(db, {
      productId,
      ...fakeReader({}),
      ...fakeFetch({ pageStatus: 500 }),
      now: () => new Date(NOW.getTime() + 60_000),
    });

    expect(second.icon).toEqual({
      ok: false,
      source: null,
      sha256: null,
      fetchedAt: null,
      note: null,
      reason: "social_preview_http_error",
      changed: false,
    });
    const after = await productRow();
    expect(after?.previewAssetId).toBe(before?.previewAssetId);
    expect(after?.previewSha256).toBe(before?.previewSha256);
    expect(after?.previewError).toBe("social_preview_http_error");
  });

  test("a product with no repository binding makes no request", async () => {
    await db.update(products).set({ repoId: null }).where(eq(products.id, productId));
    const { client, calls } = fakeReader({});
    const { fetchImpl, calls: fetches } = fakeFetch();

    const result = await refreshProductBrand(db, { productId, client, fetchImpl });

    expect(result.icon).toMatchObject({ ok: false, reason: "no_repo" });
    expect(result.social).toMatchObject({ ok: false, reason: "no_repo" });
    expect(calls).toEqual([]);
    expect(fetches).toEqual([]);
  });

  test("without a configured App nothing is fetched", async () => {
    await db.delete(githubAppPrivateKeys);
    await db.delete(githubAppConfig);
    invalidateGithubConfigCache();

    const { client, calls } = fakeReader({});
    const result = await refreshProductBrand(db, {
      productId,
      client,
      ...fakeFetch(),
    });

    expect(result.icon).toMatchObject({ ok: false, reason: "github_not_configured" });
    expect(calls).toEqual([]);
    expect(await db.select().from(assets)).toHaveLength(0);
  });

  test("on GHES the brand file still works even though the preview scrape cannot", async () => {
    await resetGithubConfig("https://ghe.example/api/v3");
    const { client } = fakeReader({
      [BRAND_ICON_PATH]: { kind: "bytes", sha: "blob-icon", bytes: PNG_SQUARE },
    });
    const { fetchImpl, calls } = fakeFetch();

    const result = await refreshProductBrand(db, {
      productId,
      client,
      fetchImpl,
      now: () => NOW,
    });

    expect(result.icon).toMatchObject({ ok: true, source: "brand_icon" });
    expect(calls).toEqual([]);
  });
});

describe("refreshProductBrand: social card", () => {
  test("brand/social-preview.png is stored for the link preview", async () => {
    const { client, calls } = fakeReader({
      [BRAND_SOCIAL_PATH]: { kind: "bytes", sha: "blob-card", bytes: PNG_WIDE },
    });

    const result = await refreshProductBrand(db, {
      productId,
      client,
      ...fakeFetch(),
      now: () => NOW,
    });

    expect(result.social).toEqual({
      ok: true,
      sha256: WIDE_SHA,
      fetchedAt: NOW.toISOString(),
      reason: null,
      changed: true,
    });
    expect(calls.some((call) => call.path === BRAND_SOCIAL_PATH)).toBe(true);

    const [asset] = await db.select().from(assets).where(eq(assets.sha256, WIDE_SHA));
    const product = await productRow();
    expect(product?.ogAssetId).toBe(asset!.id);
    expect(product?.ogBlobSha).toBe("blob-card");
    expect(product?.ogError).toBeNull();
  });

  test("a 3:1 card is refused and the previous one stays", async () => {
    await refreshProductBrand(db, {
      productId,
      ...fakeReader({
        [BRAND_SOCIAL_PATH]: { kind: "bytes", sha: "blob-card", bytes: PNG_WIDE },
      }),
      ...fakeFetch(),
      now: () => NOW,
    });
    const before = await productRow();

    const second = await refreshProductBrand(db, {
      productId,
      ...fakeReader({
        [BRAND_SOCIAL_PATH]: {
          kind: "bytes",
          sha: "blob-odd",
          bytes: PNG_ODD_RATIO,
        },
      }),
      ...fakeFetch(),
      now: () => NOW,
    });

    expect(second.social).toMatchObject({ ok: false, reason: "social_bad_ratio" });
    const after = await productRow();
    expect(after?.ogAssetId).toBe(before?.ogAssetId);
    expect(after?.ogError).toBe("social_bad_ratio");
  });

  test("a repository without the card records social_file_missing", async () => {
    const result = await refreshProductBrand(db, {
      productId,
      ...fakeReader({}),
      ...fakeFetch(),
      now: () => NOW,
    });

    expect(result.social).toMatchObject({ ok: false, reason: "social_file_missing" });
    expect((await productRow())?.ogError).toBe("social_file_missing");
  });
});

describe("refreshProductBrand: package layout", () => {
  const PKG = "plugins/sforum-oauth2-provider";

  test("a package in a subdirectory is found through its manifest id", async () => {
    const files = {
      [`${PKG}/${MANIFEST_FILE}`]: manifest("sforum.markdown-plus"),
      [`${PKG}/brand/icon.png`]: { kind: "bytes" as const, sha: "blob-nested-icon", bytes: PNG_SQUARE },
      [`${PKG}/brand/social-preview.png`]: { kind: "bytes" as const, sha: "blob-nested-card", bytes: PNG_WIDE },
    };
    const { client, calls } = fakeReader(files, {
      tree: {
        paths: [
          `${PKG}/sforum.extension.json`,
          `${PKG}/brand/icon.png`,
          `${PKG}/brand/social-preview.png`,
        ],
      },
    });

    const result = await refreshProductBrand(db, {
      productId,
      client,
      ...fakeFetch(),
      now: () => NOW,
    });

    expect(result.icon).toMatchObject({
      ok: true,
      source: "brand_icon",
      sha256: SQUARE_SHA,
      note: null,
    });
    expect(result.social).toMatchObject({ ok: true, sha256: WIDE_SHA });

    const product = await productRow();
    expect(product).toMatchObject({
      previewSource: "brand_icon",
      previewBlobSha: "blob-nested-icon",
      ogBlobSha: "blob-nested-card",
      previewNote: null,
      ogError: null,
    });
    // Root paths are tried first, then the package directory; nothing else is read.
    expect(calls.map((call) => call.path)).toEqual([
      "brand/icon.png",
      "sforum.extension.json",
      `${PKG}/sforum.extension.json`,
      `${PKG}/brand/icon.png`,
      "brand/social-preview.png",
      `${PKG}/brand/social-preview.png`,
    ]);
  });

  test("a repository with one package uses it even when the manifest id differs", async () => {
    const files = {
      [`${PKG}/${MANIFEST_FILE}`]: manifest("someone.else"),
      [`${PKG}/brand/icon.png`]: { kind: "bytes" as const, sha: "blob-nested-icon", bytes: PNG_SQUARE },
    };
    const { client } = fakeReader(files, { tree: { paths: [`${PKG}/sforum.extension.json`] } });

    const result = await refreshProductBrand(db, {
      productId,
      client,
      ...fakeFetch(),
      now: () => NOW,
    });

    expect(result.icon).toMatchObject({ ok: true, source: "brand_icon", sha256: SQUARE_SHA });
  });

  test("two candidate packages and no id match is reported instead of guessed", async () => {
    const files = {
      "plugins/a/sforum.extension.json": manifest("a.one"),
      "plugins/b/sforum.extension.json": manifest("b.two"),
    };
    const { client } = fakeReader(files, {
      tree: {
        paths: ["plugins/a/sforum.extension.json", "plugins/b/sforum.extension.json"],
      },
    });

    const result = await refreshProductBrand(db, {
      productId,
      client,
      ...fakeFetch(),
      now: () => NOW,
    });

    expect(result.icon).toMatchObject({
      ok: true,
      source: "social_preview",
      note: "brand_layout_ambiguous",
    });
    expect((await productRow())?.previewNote).toBe("brand_layout_ambiguous");
  });

  test("a truncated tree falls back to the root layout without a note", async () => {
    const { client } = fakeReader(
      {},
      { tree: { paths: ["plugins/a/sforum.extension.json"], truncated: true } },
    );

    const result = await refreshProductBrand(db, {
      productId,
      client,
      ...fakeFetch(),
      now: () => NOW,
    });

    expect(result.icon).toMatchObject({
      ok: true,
      source: "social_preview",
      note: null,
    });
  });

  test("a package at the root is confirmed by the manifest, without a tree walk", async () => {
    const files = {
      [MANIFEST_FILE]: manifest("sforum.markdown-plus"),
      [BRAND_ICON_PATH]: { kind: "bytes" as const, sha: "blob-icon", bytes: PNG_SQUARE },
    };
    const reader = fakeReader(files, {
      tree: { paths: [MANIFEST_FILE, BRAND_ICON_PATH] },
    });

    await refreshProductBrand(db, {
      productId,
      client: reader.client,
      ...fakeFetch(),
      now: () => NOW,
    });

    // The icon read succeeds at the root; only the missing card triggers the (root) lookup,
    // and the root manifest answers it — no recursive listing is needed.
    expect(reader.calls.map((call) => call.path)).not.toContain(`${PKG}/brand/icon.png`);
    expect(reader.trees).toBe(0);
  });
});
