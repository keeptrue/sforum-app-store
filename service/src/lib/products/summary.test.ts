import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { latestVersion } from "@/lib/products/version-summary";
import { closeDb, getDb, getPool, type Db } from "@/db/client";
import {
  accounts,
  products,
  releaseAssets,
  releaseVersions,
  repoReleases,
} from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";

import {
  getDashboardProduct,
  listDashboardProductRows,
  listDashboardProducts,
} from "./service";
import { EMPTY_VERSION_SUMMARY, listProductVersionSummaries } from "./summary";
import type { ReleaseVersionState } from "./types";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

let db: Db;
let ownerId: string;
let strangerId: string;
let productSequence = 0;
let releaseSequence = 0;

type VersionInput = {
  version: string;
  channel?: "stable" | "beta";
  state?: ReleaseVersionState;
  /** ISO timestamp: `latestVersion()` falls back to "newest createdAt" when nothing is published. */
  createdAt: string;
  /** Extra platform assets on the same version, to prove the count is per version row. */
  assets?: { os: string; arch: string }[];
};

async function createAccount(sub: string): Promise<string> {
  const [row] = await db
    .insert(accounts)
    .values({ issuerKey: "official", sub, username: sub })
    .returning({ id: accounts.id });
  return row!.id;
}

async function makeProduct(
  accountId: string,
  overrides: { name?: string; status?: "draft" | "published" } = {},
): Promise<string> {
  productSequence += 1;
  const [row] = await db
    .insert(products)
    .values({
      extensionId: `sforum.summary-${productSequence}`,
      name: overrides.name ?? `Summary Product ${productSequence}`,
      kind: "plugin",
      slug: `summary-product-${productSequence}`,
      ownerAccountId: accountId,
      status: overrides.status ?? "draft",
      defaultLocale: "zh-CN",
    })
    .returning({ id: products.id });
  return row!.id;
}

async function addVersion(productId: string, input: VersionInput): Promise<void> {
  releaseSequence += 1;
  const [release] = await db
    .insert(repoReleases)
    .values({
      repoId: 7000 + releaseSequence,
      githubReleaseId: releaseSequence,
      tag: `v${input.version}`,
    })
    .returning({ id: repoReleases.id });

  const state = input.state ?? "published";
  const [version] = await db
    .insert(releaseVersions)
    .values({
      productId,
      repoReleaseId: release!.id,
      version: input.version,
      channel: input.channel ?? "stable",
      state,
      sforumVersionConstraint: ">=1.0.0",
      publishedAt: state === "published" ? new Date(input.createdAt) : null,
      createdAt: new Date(input.createdAt),
    })
    .returning({ id: releaseVersions.id });

  for (const [index, asset] of (input.assets ?? []).entries()) {
    await db.insert(releaseAssets).values({
      releaseVersionId: version!.id,
      os: asset.os,
      arch: asset.arch,
      filename: `${input.version}-${asset.os}-${asset.arch}.zip`,
      size: 1024 + index,
      sha256: `${releaseSequence}-${index}`.padStart(64, "0"),
      upstreamAssetId: releaseSequence * 10 + index,
      detectionSource: "buildinfo",
    });
  }
}

/**
 * A catalogue that exercises every branch of `latestVersion()`: semver (not time) ordering,
 * a beta above the stable line, a newer unpublished version above older published ones,
 * only-yanked products, and a product with no version at all.
 */
async function seedTrickyCatalogue(): Promise<Record<string, string>> {
  const semverBeatsTime = await makeProduct(ownerId);
  await addVersion(semverBeatsTime, {
    version: "1.9.0",
    createdAt: "2026-09-01T00:00:00.000Z",
    assets: [
      { os: "linux", arch: "amd64" },
      { os: "darwin", arch: "arm64" },
    ],
  });
  // Older row, higher semver: the list must still say 1.10.0.
  await addVersion(semverBeatsTime, { version: "1.10.0", createdAt: "2026-08-01T00:00:00.000Z" });
  await addVersion(semverBeatsTime, {
    version: "3.0.0",
    state: "candidate",
    createdAt: "2026-09-20T00:00:00.000Z",
  });

  const crossChannel = await makeProduct(ownerId);
  await addVersion(crossChannel, { version: "1.2.0", channel: "stable", createdAt: "2026-09-02T00:00:00.000Z" });
  await addVersion(crossChannel, {
    version: "2.0.0-beta.1",
    channel: "beta",
    createdAt: "2026-09-03T00:00:00.000Z",
  });

  const unpublishedOnly = await makeProduct(ownerId);
  await addVersion(unpublishedOnly, { version: "9.0.0", state: "candidate", createdAt: "2026-09-01T00:00:00.000Z" });
  await addVersion(unpublishedOnly, { version: "0.1.0", state: "rejected", createdAt: "2026-09-05T00:00:00.000Z" });
  await addVersion(unpublishedOnly, {
    version: "0.2.0",
    state: "pending_review",
    createdAt: "2026-09-03T00:00:00.000Z",
  });

  const yankedOnly = await makeProduct(ownerId);
  await addVersion(yankedOnly, { version: "1.0.0", state: "yanked", createdAt: "2026-08-01T00:00:00.000Z" });

  const noVersions = await makeProduct(ownerId);

  return { semverBeatsTime, crossChannel, unpublishedOnly, yankedOnly, noVersions };
}

/**
 * Counts statements that reach PostgreSQL through the pool. Drizzle holds this very pool
 * instance, so patching `pool.query` sees every `SELECT` a service call issues.
 */
async function countStatements<T>(
  run: () => Promise<T>,
): Promise<{ value: T; statements: number }> {
  const pool = getPool();
  const original = pool.query;
  let statements = 0;
  pool.query = ((...args: unknown[]) => {
    statements += 1;
    return (original as (...inner: unknown[]) => unknown).apply(pool, args);
  }) as unknown as typeof pool.query;

  try {
    const value = await run();
    return { value, statements };
  } finally {
    pool.query = original;
  }
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
});

beforeEach(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  await getPool().query(TRUNCATE_ALL);
  ownerId = await createAccount("owner");
  strangerId = await createAccount("stranger");
});

afterAll(async () => {
  await closeDb();
});

describe("listProductVersionSummaries", () => {
  test("counts versions per product and picks the highest published semver", async () => {
    const ids = await seedTrickyCatalogue();
    const summaries = await listProductVersionSummaries(db, ownerId);

    // Two assets on 1.9.0 must not inflate the count: versions, not rows of the asset join.
    expect(summaries.get(ids.semverBeatsTime!)).toEqual({
      versionCount: 3,
      latest: { version: "1.10.0", published: true },
    });

    // Published is the filter, channel is not: a newer beta outranks the stable line.
    expect(summaries.get(ids.crossChannel!)).toEqual({
      versionCount: 2,
      latest: { version: "2.0.0-beta.1", published: true },
    });

    // Nothing published: newest `createdAt` wins, and it is marked unpublished.
    expect(summaries.get(ids.unpublishedOnly!)).toEqual({
      versionCount: 3,
      latest: { version: "0.1.0", published: false },
    });

    // Yanked is not published, so the row falls back to the same newest-first rule.
    expect(summaries.get(ids.yankedOnly!)).toEqual({
      versionCount: 1,
      latest: { version: "1.0.0", published: false },
    });

    // No version rows at all: absent from the aggregate, empty summary for the caller.
    expect(summaries.has(ids.noVersions!)).toBe(false);
  });

  test("matches latestVersion() over the full detail rows for every product", async () => {
    const ids = await seedTrickyCatalogue();
    const summaries = await listProductVersionSummaries(db, ownerId);

    // The aggregate must not restate the rule: compare it against the real helper fed with
    // complete `DashboardVersion` rows from the detail read.
    for (const productId of Object.values(ids)) {
      const detail = await getDashboardProduct(db, { accountId: ownerId, productId });
      const summary = summaries.get(productId) ?? EMPTY_VERSION_SUMMARY;
      expect(summary.latest).toEqual(latestVersion(detail.versions));
      expect(summary.versionCount).toBe(detail.versions.length);
    }
  });

  test("keeps other accounts out of the aggregate", async () => {
    const mine = await makeProduct(ownerId);
    await addVersion(mine, { version: "1.0.0", createdAt: "2026-09-01T00:00:00.000Z" });

    const theirs = await makeProduct(strangerId);
    await addVersion(theirs, { version: "5.0.0", createdAt: "2026-09-02T00:00:00.000Z" });

    const summaries = await listProductVersionSummaries(db, ownerId);
    expect([...summaries.keys()]).toEqual([mine]);

    const strangerSummary = await listProductVersionSummaries(db, strangerId);
    expect([...strangerSummary.keys()]).toEqual([theirs]);
  });
});

describe("listDashboardProductRows", () => {
  test("keeps a version-less product in the list with a zero count and no latest", async () => {
    const ids = await seedTrickyCatalogue();
    const rows = await listDashboardProductRows(db, ownerId);

    expect(rows).toHaveLength(Object.keys(ids).length);
    const empty = rows.find((row) => row.product.id === ids.noVersions!)!;
    expect(empty.versionCount).toBe(0);
    expect(empty.latest).toBeNull();

    const published = rows.find((row) => row.product.id === ids.semverBeatsTime!)!;
    expect(published.versionCount).toBe(3);
    expect(published.latest).toEqual({ version: "1.10.0", published: true });
  });

  test("lists exactly the caller's products", async () => {
    const mine = await makeProduct(ownerId);
    await addVersion(mine, { version: "1.0.0", createdAt: "2026-09-01T00:00:00.000Z" });
    const theirs = await makeProduct(strangerId);
    await addVersion(theirs, { version: "2.0.0", createdAt: "2026-09-02T00:00:00.000Z" });

    const rows = await listDashboardProductRows(db, ownerId);
    expect(rows.map((row) => row.product.id)).toEqual([mine]);

    // Same rows, same order as the list read the portal already used.
    const listed = await listDashboardProducts(db, ownerId);
    expect(rows.map((row) => row.product.id)).toEqual(listed.map((item) => item.id));
  });

  test("issues a constant number of statements as the product count grows", async () => {
    const first = await makeProduct(ownerId);
    await addVersion(first, { version: "1.0.0", createdAt: "2026-09-01T00:00:00.000Z" });

    const oneProduct = await countStatements(() => listProductVersionSummaries(db, ownerId));
    expect(oneProduct.statements).toBe(1);
    expect(oneProduct.value.size).toBe(1);

    const onePage = await countStatements(() => listDashboardProductRows(db, ownerId));
    // products + latest rejection reasons + version aggregate: fixed, not 1 + 2N.
    expect(onePage.statements).toBe(3);
    expect(onePage.value).toHaveLength(1);

    for (let index = 0; index < 24; index += 1) {
      const productId = await makeProduct(ownerId);
      await addVersion(productId, {
        version: "1.0.0",
        createdAt: "2026-09-01T00:00:00.000Z",
      });
    }

    const manyProducts = await countStatements(() => listProductVersionSummaries(db, ownerId));
    expect(manyProducts.statements).toBe(1);
    expect(manyProducts.value.size).toBe(25);

    const manyPage = await countStatements(() => listDashboardProductRows(db, ownerId));
    expect(manyPage.statements).toBe(onePage.statements);
    expect(manyPage.value).toHaveLength(25);
  });
});
