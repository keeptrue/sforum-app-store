import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import {
  accounts,
  githubInstallations,
  githubRepos,
  products,
  repoClaims,
} from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import {
  closeClaimsForRepoExtension,
  findPendingClaim,
  listPendingClaims,
  markClaimed,
  recordClaim,
} from "./claims";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

let db: Db;
let ownerId: string;
let strangerId: string;

const INSTALL = 701;
const STRANGER_INSTALL = 702;
const REPO = 8_001;
const STRANGER_REPO = 8_002;

async function makeAccount(sub: string): Promise<string> {
  const [row] = await db
    .insert(accounts)
    .values({ issuerKey: "test", sub, username: sub })
    .returning({ id: accounts.id });
  if (!row) throw new Error("account insert returned no row");
  return row.id;
}

function claim(over: Partial<Parameters<typeof recordClaim>[1]> = {}) {
  return recordClaim(db, {
    repoId: REPO,
    installationId: INSTALL,
    extensionId: "sforum.alpha",
    manifestName: "Alpha",
    tag: "v1.0.0",
    githubReleaseId: 11,
    ...over,
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
});

beforeEach(async () => {
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
});

afterAll(async () => {
  await closeDb();
});

describe("recordClaim", () => {
  test("one row per (repository, extension id): a newer tag refreshes it", async () => {
    await claim();
    await claim({ tag: "v1.1.0", githubReleaseId: 12 });

    const rows = await db.select().from(repoClaims);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tag).toBe("v1.1.0");
    expect(rows[0]?.state).toBe("pending");
  });

  test("a settled claim is not reopened by a later release", async () => {
    await claim();
    const [row] = await db.select().from(repoClaims);
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
    await markClaimed(db, {
      claimId: row!.id,
      productId: product!.id,
      accountId: ownerId,
    });

    await claim({ tag: "v2.0.0", githubReleaseId: 20 });

    const [after] = await db.select().from(repoClaims);
    expect(after?.state).toBe("claimed");
    expect(after?.tag).toBe("v1.0.0");
  });
});

describe("listPendingClaims", () => {
  test("lists only claims behind the account's own active installation", async () => {
    await claim();
    await claim({
      repoId: STRANGER_REPO,
      installationId: STRANGER_INSTALL,
      extensionId: "sforum.other",
    });

    const rows = await listPendingClaims(db, ownerId);
    expect(rows.map((row) => row.extensionId)).toEqual(["sforum.alpha"]);
    expect(rows[0]?.repoFullName).toBe("acme/ext");
    expect(rows[0]?.accountLogin).toBe("acme");
  });

  test("a suspended installation hides its claims from the queue", async () => {
    await claim();
    await db
      .update(githubInstallations)
      .set({ status: "suspended" })
      .where(eq(githubInstallations.installationId, INSTALL));
    expect(await listPendingClaims(db, ownerId)).toEqual([]);
  });
});

describe("findPendingClaim", () => {
  test("another account's claim is null", async () => {
    await claim();
    const [row] = await db.select().from(repoClaims);
    expect(await findPendingClaim(db, strangerId, row!.id)).toBeNull();
    expect(await findPendingClaim(db, ownerId, row!.id)).not.toBeNull();
  });

  test("a settled claim is no longer pending", async () => {
    await claim();
    const [row] = await db.select().from(repoClaims);
    await db.update(repoClaims).set({ state: "claimed" }).where(eq(repoClaims.id, row!.id));
    expect(await findPendingClaim(db, ownerId, row!.id)).toBeNull();
  });
});

describe("markClaimed", () => {
  test("closes once and reports the second attempt", async () => {
    await claim();
    const [row] = await db.select().from(repoClaims);
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

    expect(
      await markClaimed(db, {
        claimId: row!.id,
        productId: product!.id,
        accountId: ownerId,
      }),
    ).toBe(true);
    expect(
      await markClaimed(db, {
        claimId: row!.id,
        productId: product!.id,
        accountId: ownerId,
      }),
    ).toBe(false);
  });
});

describe("closeClaimsForRepoExtension", () => {
  test("closes only the matching extension id in that repository", async () => {
    await claim();
    await claim({ extensionId: "sforum.beta", githubReleaseId: 30 });

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

    const closed = await closeClaimsForRepoExtension(db, {
      repoId: REPO,
      extensionId: "sforum.alpha",
      productId: product!.id,
      accountId: ownerId,
    });

    expect(closed).toBe(1);
    const rows = await db.select().from(repoClaims);
    expect(rows.find((row) => row.extensionId === "sforum.alpha")?.state).toBe(
      "claimed",
    );
    expect(rows.find((row) => row.extensionId === "sforum.beta")?.state).toBe(
      "pending",
    );
  });
});
