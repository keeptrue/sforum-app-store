import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import {
  accounts,
  githubRepos,
  moderationEvents,
  productReadmes,
  productTranslations,
  products,
  releaseVersions,
  repoReleases,
} from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import type { ReleaseVersionState } from "@/lib/products/types";
import { loadModerationProductDetail, loadModerationQueue } from "./queue";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

let db: Db;
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
});

afterAll(async () => {
  await closeDb();
});

async function makeAccount(sub: string, displayName: string | null = null) {
  const [row] = await db
    .insert(accounts)
    .values({ issuerKey: "official", sub, username: sub, displayName })
    .returning({ id: accounts.id });
  return row!.id;
}

type ProductFixture = {
  name?: string;
  translationName?: string | null;
  status?: "draft" | "pending_review" | "published" | "rejected" | "delisted";
  repoId?: number | null;
  nameAtReview?: string | null;
  repoIdReviewed?: number | null;
  capabilitiesReviewed?: string[];
  updatedAt?: Date;
};

async function makeProduct(fixture: ProductFixture = {}) {
  counter += 1;
  const name = fixture.name ?? `Fixture ${counter}`;
  const [row] = await db
    .insert(products)
    .values({
      extensionId: `sforum.moderation-${counter}`,
      name,
      kind: "plugin",
      slug: `moderation-${counter}`,
      repoId: fixture.repoId === undefined ? 900 + counter : fixture.repoId,
      status: fixture.status ?? "pending_review",
      nameAtReview: fixture.nameAtReview ?? null,
      repoIdReviewed: fixture.repoIdReviewed ?? null,
      capabilitiesReviewed: fixture.capabilitiesReviewed ?? [],
      defaultLocale: "zh-CN",
      updatedAt: fixture.updatedAt ?? new Date("2026-10-01T00:00:00Z"),
    })
    .returning({ id: products.id });

  if (fixture.translationName !== null) {
    await db.insert(productTranslations).values({
      productId: row!.id,
      locale: "zh-CN",
      name: fixture.translationName ?? name,
      summary: "summary",
    });
  }
  return row!.id;
}

/** The cached README a refresh would have written for `repoId`. */
async function makeReadme(
  productId: string,
  input: { repoId: number; blobSha?: string; fetchedAt?: Date; path?: string },
) {
  await db.insert(productReadmes).values({
    productId,
    repoId: input.repoId,
    ref: "HEAD",
    path: input.path ?? "README.md",
    blobSha: input.blobSha ?? "b".repeat(40),
    markdown: "# Markdown Plus\n\nRenders GFM.",
    html: "<h1>Markdown Plus</h1>\n<p>Renders GFM.</p>",
    byteSize: 30,
    fetchedAt: input.fetchedAt ?? new Date("2026-09-05T00:00:00Z"),
  });
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
  const repoId = 900 + counter;
  const [release] = await db
    .insert(repoReleases)
    .values({
      repoId,
      githubReleaseId: 10_000 + counter,
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

async function makeEvent(input: {
  productId?: string;
  releaseVersionId?: string;
  action: string;
  actorAccountId?: string | null;
  fromState?: string | null;
  toState?: string | null;
  reason?: string | null;
  createdAt: Date;
}) {
  await db.insert(moderationEvents).values({
    productId: input.productId ?? null,
    releaseVersionId: input.releaseVersionId ?? null,
    action: input.action,
    actorAccountId: input.actorAccountId ?? null,
    fromState: input.fromState ?? null,
    toState: input.toState ?? null,
    reason: input.reason ?? null,
    createdAt: input.createdAt,
  });
}

describe("moderation queue", () => {
  test("splits pending products from versions held on a published product", async () => {
    const alice = await makeAccount("alice", "Alice");

    const pendingProduct = await makeProduct({
      name: "Markdown Plus",
      translationName: "Markdown Plus",
      status: "pending_review",
      capabilitiesReviewed: ["host.api"],
      updatedAt: new Date("2026-10-01T00:00:00Z"),
    });
    await makeVersion(pendingProduct, {
      version: "1.2.0",
      state: "candidate",
      capabilities: ["files.write", "host.api"],
    });
    await makeVersion(pendingProduct, {
      version: "1.3.0-beta.1",
      state: "pending_review",
      capabilities: ["files.write"],
      channel: "beta",
    });
    // A rejected version is history, not work in the queue.
    await makeVersion(pendingProduct, { version: "0.9.0", state: "rejected" });
    await makeEvent({
      productId: pendingProduct,
      action: "submitted",
      actorAccountId: alice,
      fromState: "draft",
      toState: "pending_review",
      createdAt: new Date("2026-10-02T09:00:00Z"),
    });

    const publishedProduct = await makeProduct({
      name: "Files",
      status: "published",
      capabilitiesReviewed: ["host.api"],
      nameAtReview: "Files",
      repoIdReviewed: 902,
      updatedAt: new Date("2026-10-03T00:00:00Z"),
    });
    const heldVersion = await makeVersion(publishedProduct, {
      version: "2.0.0",
      state: "pending_review",
      capabilities: ["host.api", "net.outbound"],
    });
    // Same product, but a candidate version of a published product is not in the
    // re-review bucket: only `pending_review` versions are.
    await makeVersion(publishedProduct, {
      version: "2.1.0",
      state: "candidate",
      capabilities: ["net.outbound"],
    });

    // Neither of these belongs in a queue.
    const draftProduct = await makeProduct({ status: "draft" });
    await makeVersion(draftProduct, { version: "1.0.0", state: "candidate" });
    const publishedNoHold = await makeProduct({
      status: "published",
      nameAtReview: "Nothing Held",
      repoIdReviewed: 905,
    });
    await makeVersion(publishedNoHold, { version: "1.0.0", state: "published" });

    const queue = await loadModerationQueue(db);

    expect(queue.products).toHaveLength(1);
    expect(queue.products[0]).toMatchObject({
      productId: pendingProduct,
      name: "Markdown Plus",
      kind: "plugin",
      submittedBy: "Alice",
      submittedAt: "2026-10-02T09:00:00.000Z",
      versionCount: 2,
      latestVersion: "1.3.0-beta.1",
      // Union of the versions a product approval would publish, sorted for the UI.
      capabilities: ["files.write", "host.api"],
    });

    expect(queue.versions).toHaveLength(1);
    expect(queue.versions[0]).toMatchObject({
      versionId: heldVersion,
      productId: publishedProduct,
      productName: "Files",
      version: "2.0.0",
      channel: "stable",
      sforumVersion: ">=1.0.0",
      capabilities: ["host.api", "net.outbound"],
      capabilitiesNew: ["net.outbound"],
      productRenamed: false,
    });
  });

  test("falls back to updated_at and no submitter when the product was never submitted", async () => {
    const productId = await makeProduct({
      status: "pending_review",
      updatedAt: new Date("2026-09-30T12:00:00Z"),
    });
    await makeVersion(productId, { version: "1.0.0", state: "candidate" });

    const [item] = (await loadModerationQueue(db)).products;
    expect(item).toBeDefined();
    expect(item!.submittedAt).toBe("2026-09-30T12:00:00.000Z");
    expect(item!.submittedBy).toBeNull();
    expect(item!.latestVersion).toBe("1.0.0");
  });

  test("orders pending products by how long they have waited", async () => {
    const old = await makeProduct({ status: "pending_review" });
    const recent = await makeProduct({ status: "pending_review" });
    const alice = await makeAccount("alice", "Alice");
    await makeEvent({
      productId: old,
      action: "submitted",
      actorAccountId: alice,
      createdAt: new Date("2026-09-01T00:00:00Z"),
    });
    await makeEvent({
      productId: recent,
      action: "submitted",
      actorAccountId: alice,
      createdAt: new Date("2026-10-01T00:00:00Z"),
    });

    const queue = await loadModerationQueue(db);
    expect(queue.products.map((item) => item.productId)).toEqual([old, recent]);
  });

  test("flags a rename after approval on a held version", async () => {
    const productId = await makeProduct({
      name: "Old Name",
      translationName: "Brand New Name",
      status: "published",
      nameAtReview: "Old Name",
      repoIdReviewed: 999,
      capabilitiesReviewed: ["host.api"],
    });
    await makeVersion(productId, {
      version: "3.0.0",
      state: "pending_review",
      capabilities: ["host.api"],
    });

    const [item] = (await loadModerationQueue(db)).versions;
    expect(item!.productRenamed).toBe(true);
    expect(item!.productName).toBe("Brand New Name");
    // Nothing new capability-wise: the rename alone is why this version is held.
    expect(item!.capabilitiesNew).toEqual([]);
  });

  test("a product without a reviewed snapshot is not labelled as renamed", async () => {
    // No snapshot is its own reason (`snapshot_missing` in the auto-publish policy); calling
    // it "renamed" would put a false badge on a product that never had an approved name.
    const productId = await makeProduct({
      name: "Legacy",
      status: "published",
      nameAtReview: null,
      repoIdReviewed: null,
    });
    await makeVersion(productId, { version: "1.0.0", state: "pending_review" });

    const [item] = (await loadModerationQueue(db)).versions;
    expect(item!.productRenamed).toBe(false);
  });
});

describe("moderation product detail", () => {
  test("assembles versions, README, repo and the review snapshot", async () => {
    const alice = await makeAccount("alice", "Alice");
    const bob = await makeAccount("bob", null);
    const productId = await makeProduct({
      name: "Markdown Plus",
      translationName: "Markdown Plus",
      status: "published",
      repoId: 4242,
      nameAtReview: "Markdown Plus",
      repoIdReviewed: 4242,
      capabilitiesReviewed: ["host.api"],
    });
    await db.insert(githubRepos).values({
      repoId: 4242,
      installationId: 77,
      fullName: "acme/markdown-plus",
      private: true,
    });

    const published = await makeVersion(productId, {
      version: "1.0.0",
      state: "published",
      capabilities: ["host.api"],
    });
    const held = await makeVersion(productId, {
      version: "1.1.0",
      state: "pending_review",
      capabilities: ["host.api", "files.write"],
    });

    // The cached README of the *bound* repository: the reviewer sees the text plus the
    // digest and fetch time that say which text they were looking at.
    await makeReadme(productId, {
      repoId: 4242,
      blobSha: "c".repeat(40),
      path: "docs/README.md",
      fetchedAt: new Date("2026-09-05T00:00:00Z"),
    });
    await makeEvent({
      productId,
      action: "submitted",
      actorAccountId: alice,
      fromState: "draft",
      toState: "pending_review",
      createdAt: new Date("2026-09-01T00:00:00Z"),
    });
    await makeEvent({
      releaseVersionId: held,
      action: "re_review_required",
      toState: "pending_review",
      reason: "unknown_capabilities",
      createdAt: new Date("2026-09-02T00:00:00Z"),
    });
    await makeEvent({
      productId,
      action: "approved",
      actorAccountId: bob,
      fromState: "pending_review",
      toState: "published",
      createdAt: new Date("2026-09-03T00:00:00Z"),
    });

    const detail = await loadModerationProductDetail(db, productId);
    expect(detail).not.toBeNull();
    expect(detail!.product).toMatchObject({
      id: productId,
      name: "Markdown Plus",
      status: "published",
      repoId: 4242,
    });
    expect(detail!.summary).toBe("summary");
    expect(detail!.repoFullName).toBe("acme/markdown-plus");
    expect(detail!.versions.map((version) => version.state)).toEqual([
      "published",
      "pending_review",
    ]);
    expect(detail!.versions.map((version) => version.id)).toEqual([published, held]);
    expect(detail!.readme).toEqual({
      path: "docs/README.md",
      html: "<h1>Markdown Plus</h1>\n<p>Renders GFM.</p>",
      blobSha: "c".repeat(40),
      fetchedAt: "2026-09-05T00:00:00.000Z",
      byteSize: 30,
      sourceUrl: "https://github.com/acme/markdown-plus/blob/HEAD/docs/README.md",
    });
    expect(detail!.publishedAt).toBeNull();
    expect(detail!.nameAtReview).toBe("Markdown Plus");
    expect(detail!.capabilitiesReviewed).toEqual(["host.api"]);
    expect(detail!.capabilitiesNew).toEqual(["files.write"]);
    expect(detail!.productRenamed).toBe(false);
    expect(detail!.submittedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(detail!.submittedBy).toBe("Alice");

    // Newest first, product and version events interleaved; a system event has no actor.
    expect(detail!.events.map((event) => event.action)).toEqual([
      "approved",
      "re_review_required",
      "submitted",
    ]);
    expect(detail!.events.map((event) => event.actor)).toEqual(["bob", null, "Alice"]);
    expect(detail!.events[1]).toMatchObject({
      fromState: null,
      toState: "pending_review",
      reason: "unknown_capabilities",
    });

  });

  test("hides a README cached from a repository the product is no longer bound to", async () => {
    const productId = await makeProduct({
      name: "Rebound",
      status: "published",
      repoId: 4242,
      nameAtReview: "Rebound",
      repoIdReviewed: 4242,
    });
    await db.insert(githubRepos).values({
      repoId: 4242,
      installationId: 77,
      fullName: "acme/rebound",
    });
    // Fetched before the rebind: this text describes someone else's project now.
    await makeReadme(productId, { repoId: 1111 });

    const detail = await loadModerationProductDetail(db, productId);
    expect(detail!.readme).toBeNull();
  });

  test("a product with no cached README reports null, not an empty document", async () => {
    const productId = await makeProduct({
      name: "Fresh",
      status: "pending_review",
      repoId: 4243,
    });
    await db.insert(githubRepos).values({
      repoId: 4243,
      installationId: 77,
      fullName: "acme/fresh",
    });

    const detail = await loadModerationProductDetail(db, productId);
    expect(detail!.readme).toBeNull();
  });

  test("a cached README without the repository row still renders, minus the source link", async () => {
    const productId = await makeProduct({
      name: "Orphan Repo",
      status: "pending_review",
      repoId: 4245,
    });
    await makeReadme(productId, { repoId: 4245 });

    const detail = await loadModerationProductDetail(db, productId);
    expect(detail!.readme).toMatchObject({ blobSha: "b".repeat(40), sourceUrl: null });
  });

  test("keeps rejected versions in the review timeline, unlike the public catalog", async () => {
    const productId = await makeProduct({ status: "rejected", name: "Revised" });
    const rejected = await makeVersion(productId, {
      version: "1.0.0",
      state: "rejected",
    });
    const detail = await loadModerationProductDetail(db, productId);
    expect(detail!.versions.map((version) => version.id)).toEqual([rejected]);
    expect(detail!.versions[0]!.state).toBe("rejected");
  });

  test("returns null for an unknown or malformed id", async () => {
    expect(await loadModerationProductDetail(db, "11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(await loadModerationProductDetail(db, "not-a-uuid")).toBeNull();
  });

  test("a submittedAt is null when the product never went through submission", async () => {
    const productId = await makeProduct({ status: "draft", name: "Fresh" });
    const detail = await loadModerationProductDetail(db, productId);
    expect(detail).not.toBeNull();
    expect(detail!.submittedAt).toBeNull();
    expect(detail!.submittedBy).toBeNull();
    expect(detail!.versions).toEqual([]);
  });
});
