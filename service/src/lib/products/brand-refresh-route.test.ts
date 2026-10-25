import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import { accounts, products } from "@/db/schema";
import { createSession } from "@/lib/auth/service";
import { resetConfigForTests } from "@/lib/config";
import { TRUNCATE_ALL } from "@/lib/test-support/db";

/**
 * `POST /api/dashboard/products/[id]/brand/refresh`.
 *
 * The transport rules that matter: a stranger's product is a 404 (existence never leaks), the
 * mutation needs a same-origin request, and an unbound product answers `no_repo` for both
 * slots without touching GitHub. The refresh itself is covered by `lib/products/brand.test.ts`
 * with an injected client; here the App is simply unconfigured, which is the cheapest way to
 * prove the route never does network work of its own.
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

let brandRoute: { POST: (request: Request, context: IdContext) => Promise<Response> };

let db: Db;
let ownerToken: string;
let strangerToken: string;
let productId: string;

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${PUBLIC_URL}${path}`, init);
}

function post(origin = PUBLIC_URL): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", origin },
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

  brandRoute = await import("@/app/api/dashboard/products/[id]/brand/refresh/route");
});

beforeEach(async () => {
  sessionToken = null;
  await getPool().query(TRUNCATE_ALL);

  const ownerId = await makeAccount("owner");
  const strangerId = await makeAccount("stranger");
  ownerToken = (await createSession(db, ownerId, { ttlSeconds: 3600 })).token;
  strangerToken = (await createSession(db, strangerId, { ttlSeconds: 3600 })).token;

  const [product] = await db
    .insert(products)
    .values({
      extensionId: "sforum.markdown-plus",
      name: "Markdown Plus",
      kind: "plugin",
      slug: "markdown-plus",
      ownerAccountId: ownerId,
      // Unbound: the route must answer `no_repo` without any GitHub traffic.
      repoId: null,
      status: "draft",
      defaultLocale: "zh-CN",
    })
    .returning({ id: products.id });
  productId = product!.id;
});

afterAll(async () => {
  await closeDb();
});

describe("POST /api/dashboard/products/[id]/brand/refresh", () => {
  test("without a session it is 401 and writes nothing", async () => {
    const response = await brandRoute.POST(
      request(`/api/dashboard/products/${productId}/brand/refresh`, post()),
      { params: Promise.resolve({ id: productId }) },
    );

    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe("unauthenticated");
  });

  test("a mutation from another origin is refused", async () => {
    sessionToken = ownerToken;
    const response = await brandRoute.POST(
      request(
        `/api/dashboard/products/${productId}/brand/refresh`,
        post("https://evil.example"),
      ),
      { params: Promise.resolve({ id: productId }) },
    );

    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("cross_origin");
  });

  test("someone else's product is a 404, not a 403", async () => {
    sessionToken = strangerToken;
    const response = await brandRoute.POST(
      request(`/api/dashboard/products/${productId}/brand/refresh`, post()),
      { params: Promise.resolve({ id: productId }) },
    );

    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("product_not_found");
  });

  test("an unbound product answers no_repo for both slots", async () => {
    sessionToken = ownerToken;
    const response = await brandRoute.POST(
      request(`/api/dashboard/products/${productId}/brand/refresh`, post()),
      { params: Promise.resolve({ id: productId }) },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      icon: { ok: boolean; reason: string };
      social: { ok: boolean; reason: string };
    };
    expect(body.icon).toMatchObject({ ok: false, reason: "no_repo" });
    expect(body.social).toMatchObject({ ok: false, reason: "no_repo" });

    const [row] = await db.select().from(products).where(eq(products.id, productId));
    expect(row?.previewError).toBeNull();
  });

  test("a non-uuid id is a 404 rather than a database error", async () => {
    sessionToken = ownerToken;
    const response = await brandRoute.POST(
      request("/api/dashboard/products/not-a-uuid/brand/refresh", post()),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );

    expect(response.status).toBe(404);
  });
});
