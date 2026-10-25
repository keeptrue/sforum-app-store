import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import { accounts, productTranslations, products } from "@/db/schema";
import { createSession } from "@/lib/auth/service";
import { resetConfigForTests } from "@/lib/config";
import { TRUNCATE_ALL } from "@/lib/test-support/db";

/**
 * The dashboard product endpoints after product identity moved to GitHub
 * (`decisions/2026-10-25-github-only-product-identity.md`).
 *
 * Three things the transport must hold: manual creation answers `410` (not a 404, so an old
 * client learns why), a `PATCH` can only move the summary/category/tags and never the
 * manifest-owned name, and the upload/screenshot routes are gone rather than merely unlinked.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

const PUBLIC_URL = "http://127.0.0.1:3000";

let sessionToken: string | null = null;

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      sessionToken && name.endsWith("session")
        ? { name, value: sessionToken }
        : undefined,
    set: () => {},
    delete: () => {},
  }),
}));

type IdContext = { params: Promise<{ id: string }> };

let productsRoute: { POST: (request: Request) => Promise<Response> };
let productRoute: {
  GET: (request: Request, context: IdContext) => Promise<Response>;
  PATCH: (request: Request, context: IdContext) => Promise<Response>;
  DELETE: (request: Request, context: IdContext) => Promise<Response>;
};

let db: Db;
let ownerId: string;
let strangerId: string;
let ownerToken: string;
let strangerToken: string;
let productId: string;

const MANIFEST_NAME = "Markdown Plus";

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${PUBLIC_URL}${path}`, init);
}

function json(method: string, body: unknown, origin = PUBLIC_URL): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  };
}

async function makeAccount(sub: string): Promise<string> {
  const [row] = await db
    .insert(accounts)
    .values({ issuerKey: "test", sub, username: sub })
    .returning({ id: accounts.id });
  if (!row) throw new Error("account insert returned no row");
  return row.id;
}

/** Every file under the dashboard products route tree, relative to that directory. */
function routeFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory()
      ? routeFiles(join(dir, entry.name), relative)
      : [relative];
  });
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.STORE_PUBLIC_URL = PUBLIC_URL;
  process.env.STORE_SESSION_SECRET = "s".repeat(64);
  process.env.STORE_DOWNLOAD_SECRET = "d".repeat(64);
  process.env.STORE_SECRET_KEYS = `test1:${Buffer.alloc(32, 5).toString("base64")}`;
  resetConfigForTests();

  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });

  productsRoute = await import("@/app/api/dashboard/products/route");
  productRoute = await import("@/app/api/dashboard/products/[id]/route");
});

beforeEach(async () => {
  sessionToken = null;
  await getPool().query(TRUNCATE_ALL);

  ownerId = await makeAccount("owner");
  strangerId = await makeAccount("stranger");

  // The row a release sync would have written: identity from the manifest, prose from the
  // developer's summary field.
  const [product] = await db
    .insert(products)
    .values({
      extensionId: "sforum.markdown-plus",
      name: MANIFEST_NAME,
      kind: "plugin",
      slug: "markdown-plus",
      ownerAccountId: ownerId,
      status: "draft",
      defaultLocale: "zh-CN",
    })
    .returning({ id: products.id });
  productId = product!.id;
  await db.insert(productTranslations).values({
    productId,
    locale: "zh-CN",
    name: MANIFEST_NAME,
    summary: "old summary",
  });

  ownerToken = (await createSession(db, ownerId, { ttlSeconds: 3600 })).token;
  strangerToken = (await createSession(db, strangerId, { ttlSeconds: 3600 })).token;
});

afterAll(async () => {
  await closeDb();
});

describe("POST /api/dashboard/products", () => {
  test("anonymous callers get 401 before the 410", async () => {
    const response = await productsRoute.POST(
      request("/api/dashboard/products", json("POST", { name: "Hand made" })),
    );
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe("unauthenticated");
  });

  test("a cross-origin create is refused with 403", async () => {
    sessionToken = ownerToken;
    const response = await productsRoute.POST(
      request(
        "/api/dashboard/products",
        json("POST", { name: "Hand made" }, "https://evil.example"),
      ),
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("cross_origin");
  });

  test("manual creation is 410 manual_create_disabled once the session passes", async () => {
    sessionToken = ownerToken;
    const response = await productsRoute.POST(
      request(
        "/api/dashboard/products",
        json("POST", {
          extensionId: "sforum.hand-made",
          name: "Hand made",
          kind: "plugin",
        }),
      ),
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      code: "manual_create_disabled",
      message: "manual_create_disabled",
    });
    // The route answers, it does not create: only the seeded product exists.
    expect(await db.select().from(products)).toHaveLength(1);
  });
});

describe("PATCH /api/dashboard/products/{id}", () => {
  test("anonymous callers get 401", async () => {
    const response = await productRoute.PATCH(
      request(`/api/dashboard/products/${productId}`, json("PATCH", { summary: "x" })),
      { params: Promise.resolve({ id: productId }) },
    );
    expect(response.status).toBe(401);
  });

  test("another account's product is a 404, never a 403", async () => {
    sessionToken = strangerToken;
    const response = await productRoute.PATCH(
      request(`/api/dashboard/products/${productId}`, json("PATCH", { summary: "x" })),
      { params: Promise.resolve({ id: productId }) },
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("product_not_found");
  });

  test("moves the summary and category while the manifest name stays put", async () => {
    sessionToken = ownerToken;
    const response = await productRoute.PATCH(
      request(
        `/api/dashboard/products/${productId}`,
        json("PATCH", { summary: "Renders GFM tables", category: "content" }),
      ),
      { params: Promise.resolve({ id: productId }) },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      product: { name: string; summary: string; category: string | null };
    };
    expect(body.product.name).toBe(MANIFEST_NAME);
    expect(body.product.summary).toBe("Renders GFM tables");
    expect(body.product.category).toBe("content");

    const [product] = await db
      .select()
      .from(products)
      .where(eq(products.id, productId));
    expect(product.name).toBe(MANIFEST_NAME);

    const [translation] = await db
      .select()
      .from(productTranslations)
      .where(eq(productTranslations.productId, productId));
    expect(translation.name).toBe(MANIFEST_NAME);
    expect(translation.summary).toBe("Renders GFM tables");
  });

  test("a name in the body is a 400 field_not_editable and changes nothing", async () => {
    sessionToken = ownerToken;
    const response = await productRoute.PATCH(
      request(
        `/api/dashboard/products/${productId}`,
        json("PATCH", { name: "Hijacked Name" }),
      ),
      { params: Promise.resolve({ id: productId }) },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("field_not_editable");
    expect(body.message).toContain("name");

    const [product] = await db
      .select()
      .from(products)
      .where(eq(products.id, productId));
    expect(product.name).toBe(MANIFEST_NAME);
  });

  test("a descriptionMd in the body is a 400 field_not_editable", async () => {
    sessionToken = ownerToken;
    const response = await productRoute.PATCH(
      request(
        `/api/dashboard/products/${productId}`,
        json("PATCH", { descriptionMd: "# long form" }),
      ),
      { params: Promise.resolve({ id: productId }) },
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("field_not_editable");
  });
});

describe("removed media routes", () => {
  test("no upload or screenshot route survives under the product routes", () => {
    const root = join(import.meta.dir, "../../app/api/dashboard/products");
    const files = routeFiles(root);

    expect(files.some((file) => file.includes("icon"))).toBe(false);
    expect(files.some((file) => file.includes("screenshot"))).toBe(false);
    // Control: the walk really sees the route tree, so the two assertions above are not
    // passing because the directory was mis-resolved.
    expect(files).toContain("[id]/readme/refresh/route.ts");
    expect(files).toContain("[id]/route.ts");
  });
});
