import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import {
  accounts,
  githubInstallations,
  githubRepos,
  products,
  repoClaims,
} from "@/db/schema";
import { createSession } from "@/lib/auth/service";
import { resetConfigForTests } from "@/lib/config";
import { TRUNCATE_ALL } from "@/lib/test-support/db";

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

let installationsRoute: { GET: (request: Request) => Promise<Response> };
let reposRoute: { GET: (request: Request) => Promise<Response> };
let refreshRoute: { POST: (request: Request) => Promise<Response> };
let importRoute: { POST: (request: Request) => Promise<Response> };
let productRepoRoute: {
  POST: (request: Request, context: IdContext) => Promise<Response>;
  DELETE: (request: Request, context: IdContext) => Promise<Response>;
};
let claimsRoute: { GET: (request: Request) => Promise<Response> };
let claimRoute: { POST: (request: Request, context: IdContext) => Promise<Response> };

let db: Db;
let ownerId: string;
let strangerId: string;
let ownerToken: string;
let strangerToken: string;
let productId: string;
let claimId: string;

const INSTALL = 801;
const STRANGER_INSTALL = 802;
const REPO = 9_001;
const STRANGER_REPO = 9_002;

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${PUBLIC_URL}${path}`, init);
}

function json(body: unknown, origin = PUBLIC_URL): RequestInit {
  return {
    method: "POST",
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

  installationsRoute = await import("@/app/api/dashboard/github/installations/route");
  reposRoute = await import("@/app/api/dashboard/github/repos/route");
  refreshRoute = await import("@/app/api/dashboard/github/repos/refresh/route");
  importRoute = await import("@/app/api/dashboard/products/import/route");
  productRepoRoute = await import("@/app/api/dashboard/products/[id]/repo/route");
  claimsRoute = await import("@/app/api/dashboard/repo-claims/route");
  claimRoute = await import("@/app/api/dashboard/repo-claims/[id]/claim/route");
});

beforeEach(async () => {
  sessionToken = null;
  await getPool().query(TRUNCATE_ALL);

  ownerId = await makeAccount("owner");
  strangerId = await makeAccount("stranger");

  await db.insert(githubInstallations).values([
    { installationId: INSTALL, accountId: ownerId, accountLogin: "acme" },
    {
      installationId: STRANGER_INSTALL,
      accountId: strangerId,
      accountLogin: "other",
    },
  ]);
  await db.insert(githubRepos).values([
    { repoId: REPO, installationId: INSTALL, fullName: "acme/ext" },
    { repoId: STRANGER_REPO, installationId: STRANGER_INSTALL, fullName: "other/ext" },
  ]);

  const [product] = await db
    .insert(products)
    .values({
      extensionId: "sforum.alpha",
      name: "Alpha",
      kind: "plugin",
      slug: "alpha",
      ownerAccountId: ownerId,
    })
    .returning({ id: products.id });
  productId = product!.id;

  const [claim] = await db
    .insert(repoClaims)
    .values({
      repoId: REPO,
      installationId: INSTALL,
      extensionId: "sforum.alpha",
      tag: "v1.0.0",
    })
    .returning({ id: repoClaims.id });
  claimId = claim!.id;

  ownerToken = (await createSession(db, ownerId, { ttlSeconds: 3600 })).token;
  strangerToken = (await createSession(db, strangerId, { ttlSeconds: 3600 })).token;
});

afterAll(async () => {
  await closeDb();
});

describe("dashboard GitHub reads", () => {
  test("anonymous callers get 401 on all three read endpoints", async () => {
    expect((await installationsRoute.GET(request("/api/dashboard/github/installations"))).status).toBe(401);
    expect((await reposRoute.GET(request("/api/dashboard/github/repos"))).status).toBe(401);
    expect((await claimsRoute.GET(request("/api/dashboard/repo-claims"))).status).toBe(401);
  });

  test("installations list carries only the caller's own installations", async () => {
    sessionToken = ownerToken;
    const response = await installationsRoute.GET(request("/api/dashboard/github/installations"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { installations: { installationId: number }[] };
    expect(body.installations.map((row) => row.installationId)).toEqual([INSTALL]);
  });

  test("repos list carries only the caller's own repositories", async () => {
    sessionToken = ownerToken;
    const response = await reposRoute.GET(request("/api/dashboard/github/repos"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { repos: { fullName: string }[] };
    expect(body.repos.map((row) => row.fullName)).toEqual(["acme/ext"]);
  });

  test("claims list carries only the caller's own claims", async () => {
    sessionToken = strangerToken;
    const response = await claimsRoute.GET(request("/api/dashboard/repo-claims"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { claims: unknown[] };
    expect(body.claims).toEqual([]);
  });
});

describe("dashboard GitHub mutations", () => {
  test("a cross-origin mutation is refused before the session is looked at", async () => {
    const response = await productRepoRoute.POST(
      request(`/api/dashboard/products/${productId}/repo`, json({ repoId: REPO }, "https://evil.test")),
      { params: Promise.resolve({ id: productId }) },
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("cross_origin");
  });

  test("binding someone else's repository is a 404", async () => {
    sessionToken = ownerToken;
    const response = await productRepoRoute.POST(
      request(`/api/dashboard/products/${productId}/repo`, json({ repoId: STRANGER_REPO })),
      { params: Promise.resolve({ id: productId }) },
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("repo_not_bindable");
  });

  test("binding a malformed repo id is a 400", async () => {
    sessionToken = ownerToken;
    const response = await productRepoRoute.POST(
      request(`/api/dashboard/products/${productId}/repo`, json({ repoId: "abc" })),
      { params: Promise.resolve({ id: productId }) },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("invalid_repo_id");
  });

  test("unbinding another account's product is a 404", async () => {
    sessionToken = strangerToken;
    const response = await productRepoRoute.DELETE(
      request(`/api/dashboard/products/${productId}/repo`, {
        method: "DELETE",
        headers: { origin: PUBLIC_URL },
      }),
      { params: Promise.resolve({ id: productId }) },
    );
    expect(response.status).toBe(404);
  });

  test("importing with a malformed repo id is a 400", async () => {
    sessionToken = ownerToken;
    const response = await importRoute.POST(
      request("/api/dashboard/products/import", json({ repoId: -1 })),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("invalid_repo_id");
  });

  test("refreshing someone else's installation is a 404", async () => {
    sessionToken = ownerToken;
    const response = await refreshRoute.POST(
      request("/api/dashboard/github/repos/refresh", json({ installationId: STRANGER_INSTALL })),
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe(
      "installation_not_found",
    );
  });

  test("claiming someone else's claim is a 404", async () => {
    sessionToken = strangerToken;
    const response = await claimRoute.POST(
      request(`/api/dashboard/repo-claims/${claimId}/claim`, json({})),
      { params: Promise.resolve({ id: claimId }) },
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("claim_not_found");
  });
});
