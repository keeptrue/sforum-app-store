import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import {
  accounts,
  auditLog,
  moderationEvents,
  productTranslations,
  products,
  releaseVersions,
  repoReleases,
} from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import type { ReleaseVersionState } from "@/lib/products/types";
import { ProductError } from "@/lib/products/service";
import {
  approveProduct,
  approveVersion,
  delistProductAsModerator,
  rejectProduct,
  rejectVersion,
} from "./service";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

const MISSING_ID = "11111111-1111-4111-8111-111111111111";

let db: Db;
let moderatorId: string;
let counter = 0;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
});

beforeEach(async () => {
  counter = 0;
  await getPool().query(TRUNCATE_ALL);
  const [moderator] = await db
    .insert(accounts)
    .values({
      issuerKey: "official",
      sub: "moderator",
      username: "mod",
      displayName: "Mod",
    })
    .returning({ id: accounts.id });
  moderatorId = moderator!.id;
});

afterAll(async () => {
  await closeDb();
});

async function makeProduct(fixture: {
  name?: string;
  status?: "draft" | "pending_review" | "published" | "rejected" | "delisted";
  repoId?: number | null;
  nameAtReview?: string | null;
  repoIdReviewed?: number | null;
  capabilitiesReviewed?: string[];
}) {
  counter += 1;
  const name = fixture.name ?? `Fixture ${counter}`;
  const [row] = await db
    .insert(products)
    .values({
      extensionId: `sforum.moderation-${counter}`,
      name,
      kind: "plugin",
      slug: `moderation-${counter}`,
      repoId: fixture.repoId === undefined ? 500 + counter : fixture.repoId,
      status: fixture.status ?? "pending_review",
      nameAtReview: fixture.nameAtReview ?? null,
      repoIdReviewed: fixture.repoIdReviewed ?? null,
      capabilitiesReviewed: fixture.capabilitiesReviewed ?? [],
      defaultLocale: "zh-CN",
    })
    .returning({ id: products.id });
  await db.insert(productTranslations).values({
    productId: row!.id,
    locale: "zh-CN",
    name,
    summary: "summary",
  });
  return row!.id;
}

async function makeVersion(
  productId: string,
  input: {
    version: string;
    state: ReleaseVersionState;
    capabilities?: string[];
    channel?: "stable" | "beta";
  },
) {
  counter += 1;
  const [release] = await db
    .insert(repoReleases)
    .values({
      repoId: 500 + counter,
      githubReleaseId: 20_000 + counter,
      tag: `v${input.version}-${counter}`,
    })
    .returning({ id: repoReleases.id });
  const [row] = await db
    .insert(releaseVersions)
    .values({
      productId,
      repoReleaseId: release!.id,
      version: input.version,
      channel: input.channel ?? "stable",
      state: input.state,
      sforumVersionConstraint: ">=1.0.0",
      capabilities: input.capabilities ?? [],
    })
    .returning({ id: releaseVersions.id });
  return row!.id;
}

async function readProduct(productId: string) {
  const [row] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  return row!;
}

async function readVersion(versionId: string) {
  const [row] = await db
    .select()
    .from(releaseVersions)
    .where(eq(releaseVersions.id, versionId))
    .limit(1);
  return row!;
}

async function trailCounts() {
  const events = await db.select().from(moderationEvents);
  const audits = await db.select().from(auditLog);
  return { events, audits };
}

async function expectProductError(
  action: Promise<unknown>,
  status: number,
  code: string,
) {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(ProductError);
    expect((error as ProductError).status).toBe(status);
    expect((error as ProductError).code).toBe(code);
    return;
  }
  throw new Error(`expected ProductError ${code}`);
}

describe("approveProduct", () => {
  test("publishes the product and every waiting version, and snapshots what was seen", async () => {
    const productId = await makeProduct({
      name: "Markdown Plus",
      status: "pending_review",
      repoId: 4242,
      capabilitiesReviewed: ["host.api"],
    });
    const stable = await makeVersion(productId, {
      version: "1.0.0",
      state: "candidate",
      capabilities: ["host.api"],
    });
    const beta = await makeVersion(productId, {
      version: "1.1.0-beta.1",
      state: "pending_review",
      capabilities: ["host.api", "files.write"],
      channel: "beta",
    });
    const rejected = await makeVersion(productId, {
      version: "0.9.0",
      state: "rejected",
    });

    const product = await approveProduct(db, { accountId: moderatorId, productId });

    expect(product).toMatchObject({ id: productId, status: "published" });
    const row = await readProduct(productId);
    expect(row.status).toBe("published");
    expect(row.publishedAt).not.toBeNull();
    expect(row.nameAtReview).toBe("Markdown Plus");
    expect(row.repoIdReviewed).toBe(4242);
    // Union of the old snapshot and what the two published versions carry.
    expect(row.capabilitiesReviewed).toEqual(["host.api", "files.write"]);
    // Materialized semver maxima recomputed after commit.
    expect(row.latestStableVersionId).toBe(stable);
    expect(row.latestBetaVersionId).toBe(beta);

    const publishedStable = await readVersion(stable);
    const publishedBeta = await readVersion(beta);
    expect(publishedStable.state).toBe("published");
    expect(publishedStable.publishedAt).not.toBeNull();
    expect(publishedBeta.state).toBe("published");
    expect(publishedBeta.publishedAt).not.toBeNull();
    // A rejected version is not resurrected by approving the product.
    expect((await readVersion(rejected)).state).toBe("rejected");

    const { events, audits } = await trailCounts();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      productId,
      releaseVersionId: null,
      action: "approved",
      fromState: "pending_review",
      toState: "published",
      actorAccountId: moderatorId,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorAccountId: moderatorId,
      action: "product.approved",
      targetType: "product",
      targetId: productId,
    });
    expect(audits[0]!.details).toMatchObject({
      versions: ["1.0.0", "1.1.0-beta.1"],
    });
  });

  test("records the actor ip in the audit row", async () => {
    const productId = await makeProduct({ status: "pending_review" });
    await approveProduct(db, {
      accountId: moderatorId,
      productId,
      ip: "203.0.113.7",
    });
    const audits = await db.select().from(auditLog);
    expect(audits[0]!.ip).toBe("203.0.113.7");
  });

  test("a second approval is a 409 and adds no second event", async () => {
    const productId = await makeProduct({ status: "pending_review" });
    await approveProduct(db, { accountId: moderatorId, productId });

    await expectProductError(
      approveProduct(db, { accountId: moderatorId, productId }),
      409,
      "invalid_state",
    );

    const { events, audits } = await trailCounts();
    expect(events).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  test("unknown product is a 404 and non-uuid input never reaches SQL", async () => {
    await expectProductError(
      approveProduct(db, { accountId: moderatorId, productId: MISSING_ID }),
      404,
      "product_not_found",
    );
    await expectProductError(
      approveProduct(db, { accountId: moderatorId, productId: "not-a-uuid" }),
      404,
      "product_not_found",
    );
    expect((await trailCounts()).events).toHaveLength(0);
  });

  test("rolls the state change back when the evidence writer fails (plan §7.4 item 19)", async () => {
    const productId = await makeProduct({ status: "pending_review" });
    const versionId = await makeVersion(productId, {
      version: "1.0.0",
      state: "candidate",
    });

    // The event/audit rows reference the actor account. A non-existent actor makes the
    // append fail *after* the product and version rows already moved, so only a real
    // transaction keeps the database consistent.
    const ghostActor = "00000000-0000-4000-8000-000000000000";
    let failed = false;
    try {
      await approveProduct(db, { accountId: ghostActor, productId });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);

    const row = await readProduct(productId);
    expect(row.status).toBe("pending_review");
    expect(row.publishedAt).toBeNull();
    expect(row.nameAtReview).toBeNull();
    expect(row.latestStableVersionId).toBeNull();
    const version = await readVersion(versionId);
    expect(version.state).toBe("candidate");
    expect(version.publishedAt).toBeNull();
    const { events, audits } = await trailCounts();
    expect(events).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });
});

describe("rejectProduct", () => {
  test("rejects without touching the versions, so they can be resubmitted", async () => {
    const productId = await makeProduct({ status: "pending_review" });
    const versionId = await makeVersion(productId, {
      version: "1.0.0",
      state: "candidate",
    });

    const product = await rejectProduct(db, {
      accountId: moderatorId,
      productId,
      reason: "  缺少安装说明  ",
    });

    expect(product.status).toBe("rejected");
    expect((await readProduct(productId)).status).toBe("rejected");
    expect((await readVersion(versionId)).state).toBe("candidate");

    const { events, audits } = await trailCounts();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      productId,
      action: "rejected",
      fromState: "pending_review",
      toState: "rejected",
      reason: "缺少安装说明",
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "product.rejected", targetId: productId });
    expect(audits[0]!.details).toEqual({ reason: "缺少安装说明" });
  });

  test("requires a non-blank reason of at most 500 characters", async () => {
    const productId = await makeProduct({ status: "pending_review" });
    for (const reason of [undefined, "", "   ", "x".repeat(501), 42]) {
      await expectProductError(
        rejectProduct(db, { accountId: moderatorId, productId, reason }),
        400,
        "invalid_reason",
      );
    }
    expect((await readProduct(productId)).status).toBe("pending_review");
    expect((await trailCounts()).events).toHaveLength(0);

    const accepted = await rejectProduct(db, {
      accountId: moderatorId,
      productId,
      reason: "y".repeat(500),
    });
    expect(accepted.status).toBe("rejected");
  });

  test("a published product cannot be rejected", async () => {
    const productId = await makeProduct({ status: "published", nameAtReview: "Live" });
    await expectProductError(
      rejectProduct(db, { accountId: moderatorId, productId, reason: "too late" }),
      409,
      "invalid_state",
    );
    expect((await trailCounts()).events).toHaveLength(0);
  });
});

describe("delistProductAsModerator", () => {
  test("takes a published product offline and leaves its versions alone", async () => {
    const productId = await makeProduct({
      status: "published",
      nameAtReview: "Live",
      capabilitiesReviewed: ["host.api"],
    });
    const versionId = await makeVersion(productId, {
      version: "1.0.0",
      state: "published",
      capabilities: ["host.api"],
    });

    const product = await delistProductAsModerator(db, {
      accountId: moderatorId,
      productId,
      reason: "impersonation",
    });

    expect(product.status).toBe("delisted");
    const row = await readProduct(productId);
    expect(row.status).toBe("delisted");
    // Delisting does not yank: the bytes stay published for a future re-approval.
    expect((await readVersion(versionId)).state).toBe("published");

    const { events, audits } = await trailCounts();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "delisted",
      fromState: "published",
      toState: "delisted",
      reason: "impersonation",
    });
    expect(audits[0]).toMatchObject({
      action: "product.delisted",
      targetId: productId,
    });
  });

  test("only a published product can be delisted", async () => {
    const productId = await makeProduct({ status: "pending_review" });
    await expectProductError(
      delistProductAsModerator(db, {
        accountId: moderatorId,
        productId,
        reason: "not live yet",
      }),
      409,
      "invalid_state",
    );
    await expectProductError(
      delistProductAsModerator(db, {
        accountId: moderatorId,
        productId,
        reason: "",
      }),
      400,
      "invalid_reason",
    );
  });
});

describe("version decisions", () => {
  test("approve requires a published product", async () => {
    const productId = await makeProduct({ status: "pending_review" });
    const versionId = await makeVersion(productId, {
      version: "2.0.0",
      state: "pending_review",
    });

    await expectProductError(
      approveVersion(db, { accountId: moderatorId, versionId }),
      409,
      "product_not_published",
    );
    expect((await readVersion(versionId)).state).toBe("pending_review");
    expect((await trailCounts()).events).toHaveLength(0);
  });

  test("publishes one held version and folds its capabilities into the snapshot", async () => {
    const productId = await makeProduct({
      name: "Files",
      status: "published",
      nameAtReview: "Files",
      repoId: 777,
      repoIdReviewed: 777,
      capabilitiesReviewed: ["host.api"],
    });
    await makeVersion(productId, {
      version: "1.0.0",
      state: "published",
      capabilities: ["host.api"],
    });
    const held = await makeVersion(productId, {
      version: "1.1.0",
      state: "pending_review",
      capabilities: ["host.api", "net.outbound"],
    });
    const stillHeld = await makeVersion(productId, {
      version: "1.2.0",
      state: "pending_review",
      capabilities: ["shell.exec"],
    });

    const product = await approveVersion(db, {
      accountId: moderatorId,
      versionId: held,
    });
    expect(product.id).toBe(productId);

    const version = await readVersion(held);
    expect(version.state).toBe("published");
    expect(version.publishedAt).not.toBeNull();
    expect(version.capabilities).toEqual(["host.api", "net.outbound"]);
    // Approving one version says nothing about the next one.
    expect((await readVersion(stillHeld)).state).toBe("pending_review");

    const row = await readProduct(productId);
    expect(row.capabilitiesReviewed).toEqual(["host.api", "net.outbound"]);
    expect(row.nameAtReview).toBe("Files");
    expect(row.latestStableVersionId).toBe(held);

    const { events, audits } = await trailCounts();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      productId: null,
      releaseVersionId: held,
      action: "version.approved",
      fromState: "pending_review",
      toState: "published",
      actorAccountId: moderatorId,
    });
    expect(audits[0]).toMatchObject({
      action: "release_version.approved",
      targetType: "release_version",
      targetId: held,
    });
  });

  test("does not rewrite an already published version's content (plan §7.4 item 14)", async () => {
    const productId = await makeProduct({
      status: "published",
      nameAtReview: "Stable",
      repoIdReviewed: 901,
      capabilitiesReviewed: ["host.api"],
    });
    const live = await makeVersion(productId, {
      version: "1.0.0",
      state: "published",
      capabilities: ["host.api"],
    });
    const before = await readVersion(live);
    const held = await makeVersion(productId, {
      version: "1.1.0",
      state: "pending_review",
      capabilities: ["host.api"],
    });

    await approveVersion(db, { accountId: moderatorId, versionId: held });

    const after = await readVersion(live);
    expect(after.version).toBe(before.version);
    expect(after.capabilities).toEqual(["host.api"]);
    expect(after.sforumVersionConstraint).toBe(before.sforumVersionConstraint);
    expect(after.publishedAt?.toISOString()).toBe(before.publishedAt?.toISOString());
    expect(after.state).toBe("published");
  });

  test("reject moves only the state and keeps the version out of the public surface", async () => {
    const productId = await makeProduct({
      status: "published",
      nameAtReview: "Live",
      repoIdReviewed: 902,
      capabilitiesReviewed: ["host.api"],
    });
    const versionId = await makeVersion(productId, {
      version: "3.0.0",
      state: "pending_review",
      capabilities: ["shell.exec"],
    });

    const product = await rejectVersion(db, {
      accountId: moderatorId,
      versionId,
      reason: "needs justification",
    });
    expect(product.id).toBe(productId);

    const version = await readVersion(versionId);
    expect(version.state).toBe("rejected");
    expect(version.publishedAt).toBeNull();
    // A rejected version does not widen the reviewed capability set.
    expect((await readProduct(productId)).capabilitiesReviewed).toEqual(["host.api"]);

    const { events, audits } = await trailCounts();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      releaseVersionId: versionId,
      action: "version.rejected",
      fromState: "pending_review",
      toState: "rejected",
      reason: "needs justification",
    });
    expect(audits[0]).toMatchObject({
      action: "release_version.rejected",
      targetId: versionId,
    });
  });

  test("a version that is not pending cannot be approved or rejected twice", async () => {
    const productId = await makeProduct({
      status: "published",
      nameAtReview: "Live",
      repoIdReviewed: 903,
    });
    const versionId = await makeVersion(productId, {
      version: "1.0.0",
      state: "published",
    });

    await expectProductError(
      approveVersion(db, { accountId: moderatorId, versionId }),
      409,
      "invalid_state",
    );
    await expectProductError(
      rejectVersion(db, { accountId: moderatorId, versionId, reason: "no" }),
      409,
      "invalid_state",
    );
    expect((await trailCounts()).events).toHaveLength(0);
  });

  test("unknown version ids are 404 for both decisions", async () => {
    await expectProductError(
      approveVersion(db, { accountId: moderatorId, versionId: MISSING_ID }),
      404,
      "version_not_found",
    );
    await expectProductError(
      rejectVersion(db, {
        accountId: moderatorId,
        versionId: MISSING_ID,
        reason: "nope",
      }),
      404,
      "version_not_found",
    );
  });

  test("a failing evidence writer rolls a version approval back (plan §7.4 item 19)", async () => {
    const productId = await makeProduct({
      status: "published",
      nameAtReview: "Live",
      repoIdReviewed: 904,
      capabilitiesReviewed: ["host.api"],
    });
    const versionId = await makeVersion(productId, {
      version: "1.5.0",
      state: "pending_review",
      capabilities: ["net.outbound"],
    });

    let failed = false;
    try {
      await approveVersion(db, {
        accountId: "00000000-0000-4000-8000-000000000000",
        versionId,
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);

    expect((await readVersion(versionId)).state).toBe("pending_review");
    expect((await readProduct(productId)).capabilitiesReviewed).toEqual(["host.api"]);
    const { events, audits } = await trailCounts();
    expect(events).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });
});
