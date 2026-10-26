import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import {
  accounts,
  githubRepos,
  productReadmes,
  productTranslations,
  products,
  repoReleases,
} from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import {
  createProduct,
  delistProduct,
  evaluateDashboardAccess,
  getDashboardProduct,
  listDashboardProducts,
  parseCreateProductInput,
  parseProductPatch,
  patchProduct,
  ProductError,
  sanitizeText,
  type CreateProductInput,
} from "./service";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

let db: Db;
let ownerId: string;
let strangerId: string;
let sequence = 0;

async function createAccount(sub: string) {
  const [row] = await db
    .insert(accounts)
    .values({ issuerKey: "official", sub, username: sub })
    .onConflictDoUpdate({
      target: [accounts.issuerKey, accounts.sub],
      set: { updatedAt: new Date() },
    })
    .returning();
  return row;
}

/**
 * Sibling suites share this database and truncate it in their own `beforeAll`, so the
 * owner rows are re-established per test instead of relying on `beforeAll` alone.
 */
async function ensureAccounts() {
  ownerId = (await createAccount("owner")).id;
  strangerId = (await createAccount("stranger")).id;
}

async function makeProduct(
  accountId: string,
  overrides: Partial<CreateProductInput> = {},
) {
  sequence += 1;
  return createProduct(db, {
    accountId,
    extensionId: `sforum.test-${sequence}`,
    name: `Test Product ${sequence}`,
    kind: "plugin",
    category: "content",
    tags: ["markdown"],
    locale: "zh-CN",
    summary: "A test product",
    ...overrides,
  });
}

async function expectProductError(
  action: Promise<unknown>,
  code: string,
  status: number,
): Promise<void> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(ProductError);
    const failure = error as ProductError;
    expect(failure.code).toBe(code);
    expect(failure.status).toBe(status);
    return;
  }
  throw new Error(`expected ProductError(${code}) but the call resolved`);
}

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.NODE_ENV = "test";
  process.env.STORE_PUBLIC_URL = "http://127.0.0.1:3000";
  process.env.STORE_SESSION_SECRET = "s".repeat(64);
  process.env.STORE_DOWNLOAD_SECRET = "d".repeat(64);
  process.env.STORE_SECRET_KEYS = `test1:${Buffer.alloc(32, 5).toString("base64")}`;

  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
  await getPool().query(TRUNCATE_ALL);

  await ensureAccounts();
});

beforeEach(async () => {
  await ensureAccounts();
});

afterAll(async () => {
  await closeDb();
});

describe("createProduct", () => {
  test("creates a draft owned by the caller with a derived slug and translation", async () => {
    const detail = await makeProduct(ownerId, {
      extensionId: "sforum.markdown-plus",
      name: "Markdown Plus",
      summary: "Renders markdown",
    });

    expect(detail.status).toBe("draft");
    expect(detail.slug).toBe("markdown-plus");
    expect(detail.extensionId).toBe("sforum.markdown-plus");
    expect(detail.kind).toBe("plugin");
    expect(detail.category).toBe("content");
    expect(detail.tags).toEqual(["markdown"]);
    expect(detail.defaultLocale).toBe("zh-CN");
    expect(detail.summary).toBe("Renders markdown");
    // Identity and media come from GitHub: nothing is uploaded and nothing is long-form.
    expect(detail.previewUrl).toBeNull();
    expect(detail.repoId).toBeNull();
    expect(detail.readme).toBeNull();

    const [product] = await db
      .select()
      .from(products)
      .where(eq(products.id, detail.id));
    expect(product.ownerAccountId).toBe(ownerId);
    expect(product.status).toBe("draft");

    const [translation] = await db
      .select()
      .from(productTranslations)
      .where(eq(productTranslations.productId, detail.id));
    expect(translation.locale).toBe("zh-CN");
    expect(translation.name).toBe("Markdown Plus");
  });

  test("rejects a duplicate extension_id with 409", async () => {
    await makeProduct(ownerId, { extensionId: "sforum.duplicate-id" });
    await expectProductError(
      makeProduct(ownerId, { extensionId: "sforum.duplicate-id" }),
      "extension_id_taken",
      409,
    );
  });

  test("rejects a duplicate explicit slug with 409", async () => {
    await makeProduct(ownerId, {
      extensionId: "sforum.slug-owner",
      name: "Slug Owner",
      slug: "taken-slug",
    });
    await expectProductError(
      makeProduct(ownerId, {
        extensionId: "sforum.slug-intruder",
        name: "Other Name",
        slug: "taken-slug",
      }),
      "slug_taken",
      409,
    );
  });

  test("de-duplicates a derived slug with -2, -3", async () => {
    const first = await makeProduct(ownerId, {
      extensionId: "sforum.derive-1",
      name: "Same Name",
    });
    const second = await makeProduct(ownerId, {
      extensionId: "sforum.derive-2",
      name: "Same Name",
    });
    const third = await makeProduct(ownerId, {
      extensionId: "sforum.derive-3",
      name: "Same Name",
    });

    expect(first.slug).toBe("same-name");
    expect(second.slug).toBe("same-name-2");
    expect(third.slug).toBe("same-name-3");
  });

  test("falls back to ext-<id8> when the name has no ASCII slug form", async () => {
    const detail = await makeProduct(ownerId, {
      extensionId: "sforum.cjk-name",
      name: "中文插件",
    });
    expect(detail.slug).toMatch(/^ext-[0-9a-f]{8}$/);
  });

  test("validates extension id, category, tags, locale and text length", async () => {
    await expectProductError(
      makeProduct(ownerId, { extensionId: "Bad_ID" }),
      "invalid_extension_id",
      400,
    );
    await expectProductError(
      makeProduct(ownerId, { extensionId: "ab" }),
      "invalid_extension_id",
      400,
    );
    await expectProductError(
      makeProduct(ownerId, { category: "nope" }),
      "invalid_category",
      400,
    );
    await expectProductError(
      makeProduct(ownerId, { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }),
      "invalid_tags",
      400,
    );
    await expectProductError(
      makeProduct(ownerId, { tags: ["x".repeat(33)] }),
      "invalid_tags",
      400,
    );
    await expectProductError(
      makeProduct(ownerId, { locale: "not a locale!" }),
      "invalid_locale",
      400,
    );
    await expectProductError(
      makeProduct(ownerId, { summary: "x".repeat(301) }),
      "text_too_long",
      400,
    );
  });

  test("dedupes tags and clears category with null", async () => {
    const detail = await makeProduct(ownerId, {
      extensionId: "sforum.tag-dedupe",
      category: null,
      tags: ["a", "a", "b"],
    });
    expect(detail.category).toBeNull();
    expect(detail.tags).toEqual(["a", "b"]);
  });
});

describe("text sanitizing", () => {
  test("strips script blocks with their content and remaining tags", () => {
    expect(sanitizeText('<script>alert("x")</script>hello')).toBe("hello");
    expect(sanitizeText("<p>Hi</p><style>body{}</style>")).toBe("Hi");
    expect(sanitizeText('<svg onload="alert(1)"/>ok')).toBe("ok");
    expect(sanitizeText("<iframe src=x></iframe>tail")).toBe("tail");
    expect(sanitizeText("<!-- comment -->visible")).toBe("visible");
    expect(sanitizeText("  plain text  ")).toBe("plain text");
  });

  test("stores a sanitized summary", async () => {
    const detail = await makeProduct(ownerId, {
      extensionId: "sforum.sanitize",
      summary: "<b>Read</b> me<script>steal()</script>",
    });
    expect(detail.summary).toBe("Read me");
  });
});

describe("ownership", () => {
  test("get/patch/delist are 404 for a non-owner and missing ids", async () => {
    const detail = await makeProduct(ownerId, { extensionId: "sforum.owner-only" });

    await expectProductError(
      getDashboardProduct(db, { accountId: strangerId, productId: detail.id }),
      "product_not_found",
      404,
    );
    await expectProductError(
      patchProduct(db, {
        accountId: strangerId,
        productId: detail.id,
        patch: { name: "Stolen" },
      }),
      "product_not_found",
      404,
    );
    await expectProductError(
      delistProduct(db, { accountId: strangerId, productId: detail.id }),
      "product_not_found",
      404,
    );
    await expectProductError(
      getDashboardProduct(db, {
        accountId: ownerId,
        productId: "00000000-0000-0000-0000-000000000000",
      }),
      "product_not_found",
      404,
    );
    await expectProductError(
      getDashboardProduct(db, { accountId: ownerId, productId: "not-a-uuid" }),
      "product_not_found",
      404,
    );

    // Still readable by its owner.
    const owned = await getDashboardProduct(db, {
      accountId: ownerId,
      productId: detail.id,
    });
    expect(owned.id).toBe(detail.id);
  });

  test("lists only the caller's products", async () => {
    await makeProduct(strangerId, { extensionId: "sforum.stranger" });
    const mine = await listDashboardProducts(db, ownerId);
    const theirs = await listDashboardProducts(db, strangerId);

    expect(theirs).toHaveLength(1);
    expect(theirs[0].extensionId).toBe("sforum.stranger");
    expect(mine.every((row) => row.extensionId !== "sforum.stranger")).toBe(true);
  });
});

describe("patchProduct", () => {
  test("updates the summary, category and tags but never the name", async () => {
    const detail = await makeProduct(ownerId, {
      extensionId: "sforum.patch-me",
      name: "Before",
    });

    const patched = await patchProduct(db, {
      accountId: ownerId,
      productId: detail.id,
      patch: {
        summary: "New summary",
        category: "security",
        tags: ["one", "two"],
      },
    });

    // The manifest owns the display name, so the dashboard can only move the prose.
    expect(patched.name).toBe("Before");
    expect(patched.summary).toBe("New summary");
    expect(patched.category).toBe("security");
    expect(patched.tags).toEqual(["one", "two"]);
    expect(patched.slug).toBe(detail.slug);

    const [product] = await db
      .select()
      .from(products)
      .where(eq(products.id, detail.id));
    expect(product.name).toBe("Before");

    const [translation] = await db
      .select()
      .from(productTranslations)
      .where(eq(productTranslations.productId, detail.id));
    expect(translation.name).toBe("Before");
    expect(translation.summary).toBe("New summary");
  });

  test("a summary-only patch keeps the stored category and tags", async () => {
    const detail = await makeProduct(ownerId, {
      extensionId: "sforum.patch-partial",
      category: "content",
      tags: ["markdown"],
    });

    const patched = await patchProduct(db, {
      accountId: ownerId,
      productId: detail.id,
      patch: { summary: "Only the prose" },
    });
    expect(patched.summary).toBe("Only the prose");
    expect(patched.category).toBe("content");
    expect(patched.tags).toEqual(["markdown"]);
  });

  test("accepts only summary, category and tags", () => {
    expect(
      parseProductPatch({ summary: "s", category: "content", tags: ["a", "b"] }),
    ).toEqual({ summary: "s", category: "content", tags: ["a", "b"] });
    expect(parseProductPatch({})).toEqual({});
    // `null` is "clear the column", which only applies to the nullable one.
    expect(parseProductPatch({ category: null })).toEqual({ category: null });
  });

  test("rejects identity fields, including name and descriptionMd, with field_not_editable", () => {
    const nonEditable = [
      "status",
      "owner_account_id",
      "ownerAccountId",
      "repo_id",
      "repoId",
      "extension_id",
      "extensionId",
      "name",
      "descriptionMd",
      "description_md",
      "defaultLocale",
      "default_locale",
    ];
    for (const field of nonEditable) {
      let thrown: unknown;
      try {
        parseProductPatch({ [field]: "x" });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProductError);
      expect((thrown as ProductError).code).toBe("field_not_editable");
      expect((thrown as ProductError).status).toBe(400);
      expect((thrown as ProductError).message).toContain(field);
    }
  });

  test("delist is a soft delete that keeps rows", async () => {
    const detail = await makeProduct(ownerId, {
      extensionId: "sforum.soft-delete",
      summary: "kept",
    });

    await delistProduct(db, { accountId: ownerId, productId: detail.id });

    const [product] = await db
      .select()
      .from(products)
      .where(eq(products.id, detail.id));
    expect(product).toBeDefined();
    expect(product.status).toBe("delisted");
    expect(product.updatedAt.getTime()).toBeGreaterThanOrEqual(
      product.createdAt.getTime(),
    );

    const translations = await db
      .select()
      .from(productTranslations)
      .where(eq(productTranslations.productId, detail.id));
    expect(translations).toHaveLength(1);
    expect(translations[0].summary).toBe("kept");
  });
});

describe("create body parsing", () => {
  test("accepts camelCase and snake_case aliases", () => {
    const input = parseCreateProductInput(
      {
        extension_id: "sforum.alias",
        name: "Alias",
        kind: "theme",
        default_locale: "en-US",
      },
      ownerId,
    );
    expect(input).toMatchObject({
      extensionId: "sforum.alias",
      kind: "theme",
      locale: "en-US",
    });
  });

  test("rejects non-objects and wrong value types", () => {
    expect(() => parseCreateProductInput([], ownerId)).toThrow(ProductError);
    expect(() => parseCreateProductInput(null, ownerId)).toThrow(ProductError);
    expect(() =>
      parseCreateProductInput({ name: 5, kind: "plugin" }, ownerId),
    ).toThrow(ProductError);
    expect(() =>
      parseCreateProductInput({ extensionId: "sforum.x", name: "x", kind: "lib" }, ownerId),
    ).toThrow(ProductError);
  });
});

describe("readme", () => {
  const REPO = 4_242;

  async function bind(detailId: string, repoId = REPO) {
    await db
      .update(products)
      .set({ repoId })
      .where(eq(products.id, detailId));
    // The suite truncates once per file, so the repository mirror is shared across tests.
    await db
      .insert(githubRepos)
      .values({ repoId, installationId: 77, fullName: "acme/markdown-plus" })
      .onConflictDoNothing();
  }

  async function putReadme(productId: string, repoId = REPO) {
    await db.insert(productReadmes).values({
      productId,
      repoId,
      ref: "HEAD",
      path: "docs/README.md",
      blobSha: "f".repeat(40),
      markdown: "# Markdown Plus",
      html: "<h1>Markdown Plus</h1>",
      byteSize: 17,
      fetchedAt: new Date("2026-09-05T12:00:00Z"),
    });
  }

  test("returns the cached README with a rebuilt source link", async () => {
    const detail = await makeProduct(ownerId, { extensionId: "sforum.readme" });
    await bind(detail.id);
    await putReadme(detail.id);

    const read = await getDashboardProduct(db, {
      accountId: ownerId,
      productId: detail.id,
    });
    expect(read.readme).toEqual({
      path: "docs/README.md",
      sourceUrl: "https://github.com/acme/markdown-plus/blob/HEAD/docs/README.md",
      blobSha: "f".repeat(40),
      fetchedAt: "2026-09-05T12:00:00.000Z",
      byteSize: 17,
      html: "<h1>Markdown Plus</h1>",
      fetchError: null,
    });
  });

  test("hides a README fetched from a repository the product no longer points at", async () => {
    const detail = await makeProduct(ownerId, { extensionId: "sforum.rebound" });
    await bind(detail.id, REPO + 1);
    await putReadme(detail.id, REPO);

    const read = await getDashboardProduct(db, {
      accountId: ownerId,
      productId: detail.id,
    });
    expect(read.readme).toBeNull();
  });

  test("a product that was never read has readme: null", async () => {
    const detail = await makeProduct(ownerId, { extensionId: "sforum.no-readme" });
    await bind(detail.id);

    const read = await getDashboardProduct(db, {
      accountId: ownerId,
      productId: detail.id,
    });
    expect(read.readme).toBeNull();
  });
});

describe("repository sync status", () => {
  const REPO = 5_151;

  test("returns the latest release sync for a bound repository", async () => {
    const detail = await makeProduct(ownerId, { extensionId: "sforum.sync" });
    await db.update(products).set({ repoId: REPO }).where(eq(products.id, detail.id));
    await db.insert(repoReleases).values({
      repoId: REPO,
      githubReleaseId: 9_100,
      tag: "v1.0.3",
      syncState: "synced",
      lastSyncedAt: new Date("2026-10-25T22:31:54Z"),
    });

    const read = await getDashboardProduct(db, {
      accountId: ownerId,
      productId: detail.id,
    });
    expect(read.sync).toEqual({
      tag: "v1.0.3",
      state: "synced",
      lastSyncedAt: "2026-10-25T22:31:54.000Z",
      error: null,
    });
  });

  test("an unbound product has no sync row", async () => {
    const detail = await makeProduct(ownerId, { extensionId: "sforum.unbound" });
    const read = await getDashboardProduct(db, {
      accountId: ownerId,
      productId: detail.id,
    });
    expect(read.sync).toBeNull();
  });
});

describe("dashboard access guard", () => {
  const publicUrl = "http://127.0.0.1:3000";
  const dashboardRequest = (method: string, origin?: string) =>
    new Request(`${publicUrl}/api/dashboard/products`, {
      method,
      headers: origin ? { origin } : undefined,
    });

  async function codeOf(result: ReturnType<typeof evaluateDashboardAccess>) {
    if (result.ok) throw new Error("expected the guard to reject the request");
    const body = (await result.response.json()) as { code: string };
    return { status: result.response.status, code: body.code };
  }

  test("rejects a cross-origin mutation with 403 before the session is consulted", async () => {
    const anonymous = evaluateDashboardAccess({
      request: dashboardRequest("POST", "https://evil.example"),
      publicUrl,
      session: null,
      mutation: true,
    });
    expect(await codeOf(anonymous)).toEqual({ status: 403, code: "cross_origin" });

    const authenticated = evaluateDashboardAccess({
      request: dashboardRequest("DELETE", "https://evil.example"),
      publicUrl,
      session: { accountId: "someone" },
      mutation: true,
    });
    expect(await codeOf(authenticated)).toEqual({
      status: 403,
      code: "cross_origin",
    });
  });

  test("anonymous callers get 401 on reads and mutations", async () => {
    for (const mutation of [true, false]) {
      const result = evaluateDashboardAccess({
        request: dashboardRequest(mutation ? "POST" : "GET"),
        publicUrl,
        session: null,
        mutation,
      });
      expect(await codeOf(result)).toEqual({
        status: 401,
        code: "unauthenticated",
      });
    }
  });

  test("a same-origin session is allowed, and reads ignore the origin", () => {
    const mutation = evaluateDashboardAccess({
      request: dashboardRequest("PATCH", publicUrl),
      publicUrl,
      session: { accountId: "owner" },
      mutation: true,
    });
    expect(mutation).toEqual({ ok: true, accountId: "owner" });

    const read = evaluateDashboardAccess({
      request: dashboardRequest("GET", "https://evil.example"),
      publicUrl,
      session: { accountId: "owner" },
      mutation: false,
    });
    expect(read).toEqual({ ok: true, accountId: "owner" });
  });
});

describe("translation fallback", () => {
  test("detail falls back to products.name when the locale row is missing", async () => {
    const detail = await makeProduct(ownerId, {
      extensionId: "sforum.no-translation",
      name: "Untranslated Name",
      summary: "will be dropped",
    });
    await db
      .delete(productTranslations)
      .where(eq(productTranslations.productId, detail.id));

    const read = await getDashboardProduct(db, {
      accountId: ownerId,
      productId: detail.id,
    });
    expect(read.name).toBe("Untranslated Name");
    expect(read.summary).toBe("");
    expect(read.readme).toBeNull();
  });
});
