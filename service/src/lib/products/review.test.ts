import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import {
  accounts,
  auditLog,
  moderationEvents,
  products,
  releaseAssets,
  releaseVersions,
  repoReleases,
} from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import { getDashboardProduct, submitProductForReview, yankReleaseVersion } from "./service";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

let db: Db;
let ownerId: string;
let strangerId: string;
let productId: string;
let versionId: string;

async function seedFixture(): Promise<void> {
  const [owner] = await db
    .insert(accounts)
    .values({ issuerKey: "official", sub: "owner", username: "owner" })
    .returning({ id: accounts.id });
  const [stranger] = await db
    .insert(accounts)
    .values({ issuerKey: "official", sub: "stranger", username: "stranger" })
    .returning({ id: accounts.id });
  ownerId = owner!.id;
  strangerId = stranger!.id;

  const [product] = await db
    .insert(products)
    .values({
      extensionId: "sforum.review-fixture",
      name: "Review Fixture",
      kind: "plugin",
      slug: "review-fixture",
      ownerAccountId: ownerId,
      repoId: 900,
      status: "draft",
      defaultLocale: "zh-CN",
    })
    .returning({ id: products.id });
  productId = product!.id;

  const [release] = await db
    .insert(repoReleases)
    .values({ repoId: 900, githubReleaseId: 1, tag: "v1.0.0" })
    .returning({ id: repoReleases.id });

  const [version] = await db
    .insert(releaseVersions)
    .values({
      productId,
      repoReleaseId: release!.id,
      version: "1.0.0",
      channel: "stable",
      state: "pending_review",
      sforumVersionConstraint: ">=1.0.0",
      capabilities: ["host.api"],
    })
    .returning({ id: releaseVersions.id });
  versionId = version!.id;

  await db.insert(releaseAssets).values({
    releaseVersionId: versionId,
    os: "linux",
    arch: "amd64",
    filename: "fixture.zip",
    size: 1024,
    sha256: "a".repeat(64),
    upstreamAssetId: 5,
    detectionSource: "buildinfo",
  });
}

beforeEach(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
  await getPool().query(TRUNCATE_ALL);
  await seedFixture();
});

describe("submitProductForReview", () => {
  test("draft with a reviewable version goes to review with event + audit", async () => {
    // Copy lives in the product row for this fixture; the service falls back to it.
    await db.update(products).set({ name: "Review Fixture" }).where(eq(products.id, productId));

    const detail = await submitProductForReview(db, {
      accountId: ownerId,
      productId,
    }).catch((error) => error);

    // No translation row with a summary yet: submission must refuse, not silently submit.
    expect(detail).toMatchObject({ code: "missing_copy" });

    const { productTranslations } = await import("@/db/schema");
    await db.insert(productTranslations).values({
      productId,
      locale: "zh-CN",
      name: "Review Fixture",
      summary: "A fixture product",
    });

    const submitted = await submitProductForReview(db, {
      accountId: ownerId,
      productId,
    });
    expect(submitted.status).toBe("pending_review");
    expect(submitted.versions.map((v) => v.state)).toEqual(["pending_review"]);

    const events = await db
      .select()
      .from(moderationEvents)
      .where(eq(moderationEvents.productId, productId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "submitted",
      fromState: "draft",
      toState: "pending_review",
    });

    const audits = await db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "product.submitted", targetId: productId });
  });

  test("is idempotent once pending", async () => {
    const { productTranslations } = await import("@/db/schema");
    await db.insert(productTranslations).values({
      productId,
      locale: "zh-CN",
      name: "Review Fixture",
      summary: "A fixture product",
    });

    await submitProductForReview(db, { accountId: ownerId, productId });
    await submitProductForReview(db, { accountId: ownerId, productId });

    expect(await db.select().from(moderationEvents)).toHaveLength(1);
  });

  test("refuses a product with no reviewable version", async () => {
    await db
      .update(releaseVersions)
      .set({ state: "needs_attention" })
      .where(eq(releaseVersions.id, versionId));

    await expect(
      submitProductForReview(db, { accountId: ownerId, productId }),
    ).rejects.toMatchObject({ code: "no_reviewable_version", status: 409 });
  });

  test("someone else's product is a 404", async () => {
    await expect(
      submitProductForReview(db, { accountId: strangerId, productId }),
    ).rejects.toMatchObject({ code: "product_not_found", status: 404 });
  });
});

describe("yankReleaseVersion", () => {
  test("published -> yanked, latest recomputed, event + audit written", async () => {
    await db
      .update(releaseVersions)
      .set({ state: "published", publishedAt: new Date() })
      .where(eq(releaseVersions.id, versionId));
    await db
      .update(products)
      .set({ status: "published", latestStableVersionId: versionId })
      .where(eq(products.id, productId));

    const detail = await yankReleaseVersion(db, {
      accountId: ownerId,
      versionId,
      reason: "broken build",
    });

    expect(detail.versions[0]).toMatchObject({
      state: "yanked",
      yankReason: "broken build",
    });

    const [row] = await db.select().from(products).where(eq(products.id, productId));
    expect(row?.latestStableVersionId).toBeNull();

    const events = await db.select().from(moderationEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "yanked",
      releaseVersionId: versionId,
      reason: "broken build",
    });
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  test("rejects a missing reason and a non-published version", async () => {
    await expect(
      yankReleaseVersion(db, { accountId: ownerId, versionId, reason: "  " }),
    ).rejects.toMatchObject({ code: "invalid_reason", status: 400 });

    await expect(
      yankReleaseVersion(db, { accountId: ownerId, versionId, reason: "why not" }),
    ).rejects.toMatchObject({ code: "invalid_state", status: 409 });
  });

  test("someone else's version is a 404", async () => {
    await db
      .update(releaseVersions)
      .set({ state: "published" })
      .where(eq(releaseVersions.id, versionId));

    await expect(
      yankReleaseVersion(db, { accountId: strangerId, versionId, reason: "nope" }),
    ).rejects.toMatchObject({ code: "version_not_found", status: 404 });
  });
});

describe("getDashboardProduct", () => {
  test("returns versions with platforms and the review snapshot", async () => {
    const detail = await getDashboardProduct(db, { accountId: ownerId, productId });
    expect(detail.versions[0]).toMatchObject({
      version: "1.0.0",
      state: "pending_review",
      capabilities: ["host.api"],
      assetPlatforms: [{ os: "linux", arch: "amd64" }],
    });
    expect(detail.nameAtReview).toBeNull();
    expect(detail.publishedAt).toBeNull();
  });
});
