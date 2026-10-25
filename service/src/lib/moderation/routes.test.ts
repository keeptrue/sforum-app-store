import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import {
  accounts,
  productTranslations,
  products,
  releaseVersions,
  repoReleases,
  storeRoles,
} from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import { createSession } from "@/lib/auth/service";
import { resetConfigForTests } from "@/lib/config";
import type { ReleaseVersionState } from "@/lib/products/types";

/**
 * Role gate at the transport boundary (plan §7.4 item 6).
 *
 * The route handlers read the session cookie through `next/headers`, which has no request
 * scope in a test process, so the cookie store is faked here. Everything else is real:
 * a Postgres session row, the `store_roles` lookup, the SQL and the JSON envelope.
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

type Route = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;

let queueRoute: { GET: (request: Request) => Promise<Response> };
let detailRoute: { GET: Route };
let approveProductRoute: { POST: Route };
let rejectProductRoute: { POST: Route };
let delistProductRoute: { POST: Route };
let approveVersionRoute: { POST: Route };
let rejectVersionRoute: { POST: Route };

let db: Db;
let counter = 0;
let moderatorId: string;
let adminId: string;
let plainUserId: string;
let moderatorToken: string;
let adminToken: string;
let plainUserToken: string;

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

  queueRoute = await import("@/app/api/moderation/queue/route");
  detailRoute = await import("@/app/api/moderation/products/[id]/route");
  approveProductRoute = await import("@/app/api/moderation/products/[id]/approve/route");
  rejectProductRoute = await import("@/app/api/moderation/products/[id]/reject/route");
  delistProductRoute = await import("@/app/api/moderation/products/[id]/delist/route");
  approveVersionRoute = await import("@/app/api/moderation/versions/[id]/approve/route");
  rejectVersionRoute = await import("@/app/api/moderation/versions/[id]/reject/route");
});

beforeEach(async () => {
  counter = 0;
  sessionToken = null;
  await getPool().query(TRUNCATE_ALL);

  moderatorId = await makeAccount("moderator");
  adminId = await makeAccount("admin");
  plainUserId = await makeAccount("plain");
  await db.insert(storeRoles).values({ accountId: moderatorId, role: "moderator" });
  await db.insert(storeRoles).values({ accountId: adminId, role: "admin" });

  moderatorToken = (await createSession(db, moderatorId, { ttlSeconds: 3600 })).token;
  adminToken = (await createSession(db, adminId, { ttlSeconds: 3600 })).token;
  plainUserToken = (await createSession(db, plainUserId, { ttlSeconds: 3600 })).token;
  sessionToken = null;
});

afterAll(async () => {
  await closeDb();
  mock.restore();
});

async function makeAccount(sub: string) {
  const [row] = await db
    .insert(accounts)
    .values({ issuerKey: "official", sub, username: sub })
    .returning({ id: accounts.id });
  return row!.id;
}

async function makeProduct(fixture: {
  status: "draft" | "pending_review" | "published" | "rejected" | "delisted";
  nameAtReview?: string | null;
  repoIdReviewed?: number | null;
  capabilitiesReviewed?: string[];
}) {
  counter += 1;
  const [row] = await db
    .insert(products)
    .values({
      extensionId: `sforum.routes-${counter}`,
      name: `Routes ${counter}`,
      kind: "plugin",
      slug: `routes-${counter}`,
      repoId: 700 + counter,
      status: fixture.status,
      nameAtReview: fixture.nameAtReview ?? null,
      repoIdReviewed: fixture.repoIdReviewed ?? null,
      capabilitiesReviewed: fixture.capabilitiesReviewed ?? [],
      defaultLocale: "zh-CN",
    })
    .returning({ id: products.id });
  await db.insert(productTranslations).values({
    productId: row!.id,
    locale: "zh-CN",
    name: `Routes ${counter}`,
    summary: "summary",
  });
  return row!.id;
}

async function makeVersion(
  productId: string,
  input: { version: string; state: ReleaseVersionState; capabilities?: string[] },
) {
  counter += 1;
  const [release] = await db
    .insert(repoReleases)
    .values({
      repoId: 700 + counter,
      githubReleaseId: 30_000 + counter,
      tag: `v${input.version}-${counter}`,
    })
    .returning({ id: repoReleases.id });
  const [row] = await db
    .insert(releaseVersions)
    .values({
      productId,
      repoReleaseId: release!.id,
      version: input.version,
      channel: "stable",
      state: input.state,
      sforumVersionConstraint: ">=1.0.0",
      capabilities: input.capabilities ?? [],
    })
    .returning({ id: releaseVersions.id });
  return row!.id;
}

type Call = { status: number; body: Record<string, unknown> };

async function call(response: Promise<Response>): Promise<Call> {
  const result = await response;
  return { status: result.status, body: (await result.json()) as Record<string, unknown> };
}

function getRequest(path: string, origin?: string): Request {
  return new Request(`${PUBLIC_URL}${path}`, {
    method: "GET",
    headers: origin ? { origin } : undefined,
  });
}

function postRequest(
  path: string,
  input: { origin?: string; body?: unknown; raw?: boolean } = {},
): Request {
  const headers: Record<string, string> = {};
  if (input.origin) headers.origin = input.origin;
  if (input.raw) return new Request(`${PUBLIC_URL}${path}`, { method: "POST", headers });
  if (input.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${PUBLIC_URL}${path}`, {
    method: "POST",
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
}

const id = (value: string) => ({ params: Promise.resolve({ id: value }) });

/**
 * The same three-way gate for every endpoint: anonymous -> 401, authenticated without a
 * store role -> 403, moderator -> past the gate (`allowed`).
 */
async function expectGate(
  run: (token: string | null) => Promise<Call>,
  allowed: number,
) {
  sessionToken = null;
  const anonymous = await run(null);
  expect(anonymous.status).toBe(401);
  expect(anonymous.body.code).toBe("unauthenticated");

  sessionToken = plainUserToken;
  const plain = await run(plainUserToken);
  expect(plain.status).toBe(403);
  expect(plain.body.code).toBe("forbidden");

  sessionToken = moderatorToken;
  const moderator = await run(moderatorToken);
  expect(moderator.status).toBe(allowed);
}

describe("moderation role gate", () => {
  test("queue: 401 anonymous, 403 without a store role, 403 for a legacy admin row, 200 for a moderator", async () => {
    const productId = await makeProduct({ status: "pending_review" });
    await makeVersion(productId, { version: "1.0.0", state: "candidate" });

    await expectGate(() => call(queueRoute.GET(getRequest("/api/moderation/queue"))), 200);

    // `store_roles.role='admin'` rows survive from the S1 bootstrap but authorize nothing:
    // the store administrator is a local account (2026-10-25-admin-local-identity).
    sessionToken = adminToken;
    const legacyAdmin = await call(queueRoute.GET(getRequest("/api/moderation/queue")));
    expect(legacyAdmin.status).toBe(403);
    expect(legacyAdmin.body.code).toBe("forbidden");

    sessionToken = moderatorToken;
    const moderator = await call(queueRoute.GET(getRequest("/api/moderation/queue")));
    expect(moderator.status).toBe(200);
    const queue = moderator.body.queue as { products: unknown[] };
    expect(queue.products).toHaveLength(1);
  });

  test("product detail: 401 / 403 / 200 and 404 for an unknown id", async () => {
    const productId = await makeProduct({ status: "pending_review" });

    await expectGate(
      () => call(detailRoute.GET(getRequest(`/api/moderation/products/${productId}`), id(productId))),
      200,
    );

    sessionToken = moderatorToken;
    const unknown = await call(
      detailRoute.GET(
        getRequest("/api/moderation/products/11111111-1111-4111-8111-111111111111"),
        id("11111111-1111-4111-8111-111111111111"),
      ),
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("product_not_found");
  });

  test("product approve: 401 / 403 / 200", async () => {
    const productId = await makeProduct({ status: "pending_review" });
    await makeVersion(productId, { version: "1.0.0", state: "candidate" });
    const path = `/api/moderation/products/${productId}/approve`;

    await expectGate(
      () => call(approveProductRoute.POST(postRequest(path), id(productId))),
      200,
    );
    expect((await getProductRow(productId)).status).toBe("published");
  });

  test("product reject: 401 / 403 / 200 with a reason", async () => {
    const productId = await makeProduct({ status: "pending_review" });
    const path = `/api/moderation/products/${productId}/reject`;

    await expectGate(
      () => call(rejectProductRoute.POST(postRequest(path, { body: { reason: "no docs" } }), id(productId))),
      200,
    );
    expect((await getProductRow(productId)).status).toBe("rejected");
  });

  test("product delist: 401 / 403 / 200 with a reason", async () => {
    const productId = await makeProduct({
      status: "published",
      nameAtReview: "Live",
      repoIdReviewed: 701,
    });
    const path = `/api/moderation/products/${productId}/delist`;

    await expectGate(
      () => call(delistProductRoute.POST(postRequest(path, { body: { reason: "impersonation" } }), id(productId))),
      200,
    );
    expect((await getProductRow(productId)).status).toBe("delisted");
  });

  test("version approve: 401 / 403 / 200", async () => {
    const productId = await makeProduct({
      status: "published",
      nameAtReview: "Live",
      repoIdReviewed: 702,
      capabilitiesReviewed: ["host.api"],
    });
    const versionId = await makeVersion(productId, {
      version: "2.0.0",
      state: "pending_review",
      capabilities: ["host.api", "files.write"],
    });
    const path = `/api/moderation/versions/${versionId}/approve`;

    await expectGate(
      () => call(approveVersionRoute.POST(postRequest(path), id(versionId))),
      200,
    );
    expect((await getVersionRow(versionId)).state).toBe("published");
  });

  test("version reject: 401 / 403 / 200 with a reason", async () => {
    const productId = await makeProduct({
      status: "published",
      nameAtReview: "Live",
      repoIdReviewed: 703,
    });
    const versionId = await makeVersion(productId, {
      version: "3.0.0",
      state: "pending_review",
    });
    const path = `/api/moderation/versions/${versionId}/reject`;

    await expectGate(
      () => call(rejectVersionRoute.POST(postRequest(path, { body: { reason: "unclear" } }), id(versionId))),
      200,
    );
    expect((await getVersionRow(versionId)).state).toBe("rejected");
  });
});

describe("moderation transport", () => {
  test("a cross-origin mutation is refused before the session is looked at", async () => {
    const productId = await makeProduct({ status: "pending_review" });
    sessionToken = moderatorToken;

    const crossOrigin = await call(
      approveProductRoute.POST(
        postRequest(`/api/moderation/products/${productId}/approve`, {
          origin: "https://evil.example",
        }),
        id(productId),
      ),
    );
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.body.code).toBe("cross_origin");
    expect((await getProductRow(productId)).status).toBe("pending_review");

    // Same rule for an anonymous caller: the transport check comes first.
    sessionToken = null;
    const anonymous = await call(
      approveProductRoute.POST(
        postRequest(`/api/moderation/products/${productId}/approve`, {
          origin: "https://evil.example",
        }),
        id(productId),
      ),
    );
    expect(anonymous.status).toBe(403);
    expect(anonymous.body.code).toBe("cross_origin");
  });

  test("a same-origin mutation without a body is accepted for approve", async () => {
    const productId = await makeProduct({ status: "pending_review" });
    sessionToken = moderatorToken;
    const response = await call(
      approveProductRoute.POST(
        postRequest(`/api/moderation/products/${productId}/approve`, {
          origin: PUBLIC_URL,
        }),
        id(productId),
      ),
    );
    expect(response.status).toBe(200);
    expect((response.body.product as { status: string }).status).toBe("published");
  });

  test("the queue envelope carries both buckets", async () => {
    const pendingProduct = await makeProduct({ status: "pending_review" });
    await makeVersion(pendingProduct, { version: "1.0.0", state: "candidate" });
    const published = await makeProduct({
      status: "published",
      nameAtReview: "Live",
      repoIdReviewed: 704,
      capabilitiesReviewed: ["host.api"],
    });
    const heldVersion = await makeVersion(published, {
      version: "2.0.0",
      state: "pending_review",
      capabilities: ["host.api", "shell.exec"],
    });

    sessionToken = moderatorToken;
    const response = await call(queueRoute.GET(getRequest("/api/moderation/queue", PUBLIC_URL)));
    expect(response.status).toBe(200);
    const queue = response.body.queue as {
      products: { productId: string }[];
      versions: { versionId: string; capabilitiesNew: string[] }[];
    };
    expect(queue.products.map((item) => item.productId)).toEqual([pendingProduct]);
    expect(queue.versions.map((item) => item.versionId)).toEqual([heldVersion]);
    expect(queue.versions[0]!.capabilitiesNew).toEqual(["shell.exec"]);
  });

  test("reject without a reason is a 400 with the stable code", async () => {
    const productId = await makeProduct({ status: "pending_review" });
    sessionToken = moderatorToken;

    const missing = await call(
      rejectProductRoute.POST(
        postRequest(`/api/moderation/products/${productId}/reject`, { raw: true }),
        id(productId),
      ),
    );
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("invalid_json");

    const blank = await call(
      rejectProductRoute.POST(
        postRequest(`/api/moderation/products/${productId}/reject`, { body: { reason: "  " } }),
        id(productId),
      ),
    );
    expect(blank.status).toBe(400);
    expect(blank.body.code).toBe("invalid_reason");
  });

  test("a state machine violation surfaces as 409", async () => {
    const productId = await makeProduct({ status: "draft" });
    const versionId = await makeVersion(productId, {
      version: "1.0.0",
      state: "pending_review",
    });
    sessionToken = moderatorToken;

    const approveAgain = await call(
      approveProductRoute.POST(
        postRequest(`/api/moderation/products/${productId}/approve`),
        id(productId),
      ),
    );
    expect(approveAgain.status).toBe(409);
    expect(approveAgain.body.code).toBe("invalid_state");

    const versionBeforeProduct = await call(
      approveVersionRoute.POST(
        postRequest(`/api/moderation/versions/${versionId}/approve`),
        id(versionId),
      ),
    );
    expect(versionBeforeProduct.status).toBe(409);
    expect(versionBeforeProduct.body.code).toBe("product_not_published");
  });
});

async function getProductRow(productId: string) {
  const [row] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  return row!;
}

async function getVersionRow(versionId: string) {
  const [row] = await db
    .select()
    .from(releaseVersions)
    .where(eq(releaseVersions.id, versionId))
    .limit(1);
  return row!;
}
