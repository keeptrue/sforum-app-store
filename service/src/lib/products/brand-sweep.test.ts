import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import { accounts, githubRepos, products } from "@/db/schema";
import { resetConfigForTests } from "@/lib/config";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import { BRAND_SWEEP_AGE_MS, sweepStaleBrands } from "./brand-sweep";

/**
 * The daily sweep is the backstop for every trigger the store cannot observe: a missed
 * webhook, an App that only gained the `push` subscription after the product existed, a
 * database restored from backup. It must pick exactly the rows that are due, and it must not
 * spend an API call on a repository whose installation is gone.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

const NOW = new Date("2026-10-25T04:17:00Z");
const STALE = new Date(NOW.getTime() - BRAND_SWEEP_AGE_MS - 60_000);
const FRESH = new Date(NOW.getTime() - 60_000);

let db: Db;
let ownerId: string;

async function makeProduct(input: {
  slug: string;
  repoId: number | null;
  previewFetchedAt?: Date | null;
  ogFetchedAt?: Date | null;
}): Promise<string> {
  const [row] = await db
    .insert(products)
    .values({
      extensionId: `sforum.${input.slug}`,
      name: input.slug,
      kind: "plugin",
      slug: input.slug,
      ownerAccountId: ownerId,
      repoId: input.repoId,
      status: "published",
      defaultLocale: "zh-CN",
      previewFetchedAt: input.previewFetchedAt ?? null,
      ogFetchedAt: input.ogFetchedAt ?? null,
    })
    .returning({ id: products.id });
  return row!.id;
}

async function makeRepo(repoId: number, upstream: "connected" | "disconnected") {
  await db.insert(githubRepos).values({
    repoId,
    installationId: 7,
    fullName: `acme/repo-${repoId}`,
    upstreamState: upstream,
  });
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.STORE_PUBLIC_URL = "http://127.0.0.1:3000";
  process.env.STORE_SESSION_SECRET = "s".repeat(64);
  process.env.STORE_DOWNLOAD_SECRET = "d".repeat(64);
  process.env.STORE_SECRET_KEYS = `test1:${Buffer.alloc(32, 5).toString("base64")}`;
  resetConfigForTests();

  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
});

beforeEach(async () => {
  await getPool().query(TRUNCATE_ALL);
  const [account] = await db
    .insert(accounts)
    .values({ issuerKey: "test", sub: "owner", username: "owner" })
    .returning({ id: accounts.id });
  ownerId = account!.id;
});

afterAll(async () => {
  await closeDb();
});

describe("sweepStaleBrands", () => {
  test("picks stale and never-fetched rows, in oldest-first order", async () => {
    await makeRepo(1, "connected");
    const never = await makeProduct({ slug: "never", repoId: 1 });
    const stale = await makeProduct({ slug: "stale", repoId: 1, previewFetchedAt: STALE, ogFetchedAt: STALE });
    const fresh = await makeProduct({ slug: "fresh", repoId: 1, previewFetchedAt: FRESH, ogFetchedAt: FRESH });
    const iconFreshCardMissing = await makeProduct({
      slug: "card-missing",
      repoId: 1,
      previewFetchedAt: FRESH,
      ogFetchedAt: null,
    });

    const seen: string[] = [];
    const result = await sweepStaleBrands(db, {
      now: NOW,
      gapMs: 0,
      refresh: async (productId) => {
        seen.push(productId);
      },
    });

    expect(result).toEqual({ scanned: 3, refreshed: 3, failed: 0 });
    expect(seen[0]).toBe(never);
    expect(seen).toContain(stale);
    expect(seen).toContain(iconFreshCardMissing);
    expect(seen).not.toContain(fresh);
  });

  test("skips unbound products and repositories whose upstream is gone", async () => {
    await makeRepo(2, "disconnected");
    await makeProduct({ slug: "unbound", repoId: null });
    await makeProduct({ slug: "gone", repoId: 2 });

    const seen: string[] = [];
    const result = await sweepStaleBrands(db, {
      now: NOW,
      gapMs: 0,
      refresh: async (productId) => {
        seen.push(productId);
      },
    });

    expect(result.scanned).toBe(0);
    expect(seen).toEqual([]);
  });

  test("one failing refresh does not stop the batch", async () => {
    await makeRepo(3, "connected");
    const first = await makeProduct({ slug: "first", repoId: 3 });
    const second = await makeProduct({ slug: "second", repoId: 3 });

    const seen: string[] = [];
    const result = await sweepStaleBrands(db, {
      now: NOW,
      gapMs: 0,
      refresh: async (productId) => {
        seen.push(productId);
        if (productId === first) throw new Error("boom");
        return undefined;
      },
    });

    expect(result).toEqual({ scanned: 2, refreshed: 1, failed: 1 });
    // Order within one `preview_fetched_at` bucket is the uuid, not insertion order.
    expect(seen).toHaveLength(2);
    expect(seen).toContain(first);
    expect(seen).toContain(second);
  });

  test("the batch limit bounds one run", async () => {
    await makeRepo(4, "connected");
    for (let index = 0; index < 3; index += 1) {
      await makeProduct({ slug: `p${index}`, repoId: 4 });
    }

    const result = await sweepStaleBrands(db, {
      limit: 2,
      now: NOW,
      gapMs: 0,
      refresh: async () => undefined,
    });

    expect(result.scanned).toBe(2);
  });
});
