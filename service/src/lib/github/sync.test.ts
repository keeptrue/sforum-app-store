import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import {
  moderationEvents,
  productTranslations,
  products,
  releaseAssets,
  releaseVersions,
  repoClaims,
  webhookDeliveries,
} from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import {
  elfHeader,
  makeZip,
  pluginManifest,
  themeManifest,
} from "../../../test/zip-fixture";
import type { GithubRelease, GithubReleaseAsset } from "./client";
import { markWebhookDelivery, recordWebhookDelivery } from "./deliveries";
import { syncRelease, type AssetFetcher } from "./sync";
import { verifyGithubSignature } from "./webhook";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

let db: Db;
const fixtures = new Map<string, Buffer>();

const fetchAsset: AssetFetcher = async (asset) => {
  const data = fixtures.get(asset.name);
  if (!data) throw new Error(`missing fixture ${asset.name}`);
  const dir = await mkdtemp(join(tmpdir(), "sforum-sync-test-"));
  const path = join(dir, asset.name);
  await writeFile(path, data);
  return {
    path,
    sha256: createHash("sha256").update(data).digest("hex"),
    size: data.length,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
};

function asset(id: number, name: string, data: Buffer): GithubReleaseAsset {
  return {
    id,
    name,
    size: data.length,
    content_type: "application/zip",
    browser_download_url: `https://example.test/${name}`,
  };
}

function release(
  id: number,
  tag: string,
  assets: GithubReleaseAsset[],
  prerelease = false,
): GithubRelease {
  return {
    id,
    tag_name: tag,
    target_commitish: "main",
    prerelease,
    draft: false,
    body: "release notes",
    assets,
  };
}

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
  await getPool().query(TRUNCATE_ALL);
});

afterAll(async () => {
  await closeDb();
});

describe("GitHub webhook", () => {
  test("verifies sha256 signatures", () => {
    const payload = Buffer.from(JSON.stringify({ action: "published" }));
    const secret = "webhook-secret";
    const signature = `sha256=${createHmac("sha256", secret)
      .update(payload)
      .digest("hex")}`;

    expect(verifyGithubSignature(payload, signature, secret)).toBe(true);
    expect(verifyGithubSignature(payload, signature, "other")).toBe(false);
    expect(
      verifyGithubSignature(Buffer.from("tampered"), signature, secret),
    ).toBe(false);
    expect(verifyGithubSignature(payload, "sha1=abc", secret)).toBe(false);
  });

  test("records a delivery once and marks it processed", async () => {
    const input = {
      deliveryId: "delivery-1",
      event: "release",
      action: "published",
      payload: { action: "published" },
    };
    expect(await recordWebhookDelivery(db, input)).toBe(true);
    expect(await recordWebhookDelivery(db, input)).toBe(false);

    await markWebhookDelivery(db, input.deliveryId, "processed");
    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, input.deliveryId));
    expect(row?.status).toBe("processed");
    expect(row?.processedAt).not.toBeNull();
  });
});

describe("release sync", () => {
  const THEME = "sforum.theme-paper";
  const MARKDOWN = "sforum.markdown-plus";
  const REPO = 4242;
  let seed = 0;

  async function ensureProduct(input: {
    extensionId: string;
    name: string;
    kind?: "plugin" | "theme";
    repoId?: number | null;
  }): Promise<string> {
    const [existing] = await db
      .select()
      .from(products)
      .where(eq(products.extensionId, input.extensionId))
      .limit(1);
    if (existing) return existing.id;
    seed += 1;
    const [row] = await db
      .insert(products)
      .values({
        extensionId: input.extensionId,
        name: input.name,
        kind: input.kind ?? "plugin",
        slug: `sync-seed-${seed}`,
        repoId: input.repoId === undefined ? REPO : input.repoId,
      })
      .returning();
    if (!row) throw new Error("product insert returned no row");
    return row.id;
  }

  beforeAll(async () => {
    // Two products already bound to the repository under test: sync writes into them.
    await ensureProduct({ extensionId: THEME, name: "Paper", kind: "theme" });
    await ensureProduct({ extensionId: MARKDOWN, name: "Markdown Plus" });
  });

  test("records a claim instead of creating a product for an unknown extension id", async () => {
    const themeZip = await makeZip({
      "sforum.extension.json": JSON.stringify({
        ...themeManifest,
        id: "sforum.claim-theme",
      }),
    });
    const pluginZip = await makeZip({
      "sforum.extension.json": JSON.stringify({
        ...pluginManifest,
        id: "sforum.claim-plugin",
      }),
      "backend/plugin": elfHeader(),
    });

    const result = await syncRelease({
      db,
      repoId: REPO,
      installationId: 77,
      release: release(8, "v0.7.0", [
        asset(80, "claim-theme.zip", themeZip),
        asset(81, "claim-plugin.zip", pluginZip),
      ]),
      fetchAsset: async (item) => {
        const data = item.name === "claim-theme.zip" ? themeZip : pluginZip;
        const dir = await mkdtemp(join(tmpdir(), "sforum-sync-test-"));
        const path = join(dir, item.name);
        await writeFile(path, data);
        return {
          path,
          sha256: createHash("sha256").update(data).digest("hex"),
          size: data.length,
          cleanup: () => rm(dir, { recursive: true, force: true }),
        };
      },
    });

    // Nothing was written to `products`, and no version exists for an id with no owner.
    expect(result.versions).toBe(0);
    expect(result.issues.map((issue) => issue.code).sort()).toEqual([
      "product_unclaimed",
      "product_unclaimed",
    ]);
    const owned = await db
      .select()
      .from(products)
      .where(eq(products.extensionId, "sforum.claim-theme"));
    expect(owned).toHaveLength(0);

    const claims = await db.select().from(repoClaims);
    expect(claims.map((row) => row.extensionId).sort()).toEqual([
      "sforum.claim-plugin",
      "sforum.claim-theme",
    ]);
    expect(claims.every((row) => row.state === "pending")).toBe(true);
    expect(claims.every((row) => row.installationId === 77)).toBe(true);
    expect(claims.every((row) => row.tag === "v0.7.0")).toBe(true);
  });

  test("stores a multi-extension tag with theme and plugin assets", async () => {
    const themeZip = await makeZip({
      "sforum.extension.json": JSON.stringify(themeManifest),
    });
    const pluginZip = await makeZip({
      "sforum.extension.json": JSON.stringify(pluginManifest),
      "backend/plugin": elfHeader(),
    });
    fixtures.set("theme-paper-any.zip", themeZip);
    fixtures.set("markdown-linux-amd64.zip", pluginZip);

    const result = await syncRelease({
      db,
      repoId: REPO,
      release: release(9, "v0.8.0", [
        asset(1, "theme-paper-any.zip", themeZip),
        asset(2, "markdown-linux-amd64.zip", pluginZip),
      ]),
      fetchAsset,
    });

    expect(result.issues).toEqual([]);
    expect(result.versions).toBe(2);
    expect(result.assets).toBe(2);

    const versionRows = await db.select().from(releaseVersions);
    expect(versionRows).toHaveLength(2);
    expect(versionRows.every((row) => row.state === "pending_review")).toBe(
      true,
    );

    // Manifest display metadata is copied per version so the storefront and the
    // moderation queue can show exactly what the host will show.
    const [themeProduct] = await db
      .select()
      .from(products)
      .where(eq(products.extensionId, THEME))
      .limit(1);
    const [markdownProduct] = await db
      .select()
      .from(products)
      .where(eq(products.extensionId, MARKDOWN))
      .limit(1);
    const themeRow = versionRows.find((row) => row.productId === themeProduct?.id);
    const pluginRow = versionRows.find(
      (row) => row.productId === markdownProduct?.id,
    );
    expect(themeRow).toMatchObject({
      manifestDescription: themeManifest.description,
      manifestUrl: themeManifest.url,
      manifestAuthorName: themeManifest.author.name,
      manifestAuthorUrl: null,
      manifestLangs: {},
    });
    expect(pluginRow).toMatchObject({
      manifestAuthorName: pluginManifest.author.name,
      manifestAuthorUrl: pluginManifest.author.url,
    });

    const assetRows = await db.select().from(releaseAssets);
    expect(assetRows).toHaveLength(2);
    const themeAsset = assetRows.find((row) => row.os === "any");
    expect(themeAsset).toMatchObject({ arch: "any", detectionSource: "manifest" });
    const pluginAsset = assetRows.find((row) => row.os === "linux");
    expect(pluginAsset).toMatchObject({
      arch: "amd64",
      detectionSource: "header",
    });

    const again = await syncRelease({
      db,
      repoId: REPO,
      release: release(9, "v0.8.0", [
        asset(1, "theme-paper-any.zip", themeZip),
        asset(2, "markdown-linux-amd64.zip", pluginZip),
      ]),
      fetchAsset,
    });
    expect(again.versions).toBe(0);
    expect(again.issues).toEqual([]);
    expect(await db.select().from(releaseVersions)).toHaveLength(2);
  });

  test("refuses to write versions into a product bound to another repository", async () => {
    const elsewhere = "sforum.elsewhere";
    await ensureProduct({
      extensionId: elsewhere,
      name: "Elsewhere",
      repoId: 9999,
    });
    const zip = await makeZip({
      "sforum.extension.json": JSON.stringify({ ...pluginManifest, id: elsewhere }),
      "backend/plugin": elfHeader(),
    });

    const result = await syncRelease({
      db,
      repoId: REPO,
      installationId: 77,
      release: release(11, "v1.0.0", [asset(110, "elsewhere.zip", zip)]),
      fetchAsset: async (item) => {
        const dir = await mkdtemp(join(tmpdir(), "sforum-sync-test-"));
        const path = join(dir, item.name);
        await writeFile(path, zip);
        return {
          path,
          sha256: createHash("sha256").update(zip).digest("hex"),
          size: zip.length,
          cleanup: () => rm(dir, { recursive: true, force: true }),
        };
      },
    });

    expect(result.versions).toBe(0);
    expect(result.issues.map((issue) => issue.code)).toEqual(["repo_mismatch"]);
    const versions = await db
      .select()
      .from(releaseVersions)
      .where(eq(releaseVersions.version, "1.0.0"));
    expect(versions).toHaveLength(0);
  });

  test("marks a same-version digest change as needs_attention", async () => {
    const changed = await makeZip({
      "sforum.extension.json": JSON.stringify(pluginManifest),
      "backend/plugin": Buffer.concat([elfHeader(), Buffer.from("changed")]),
    });
    fixtures.set("markdown-linux-amd64.zip", changed);

    const result = await syncRelease({
      db,
      repoId: REPO,
      release: release(9, "v0.8.0", [
        asset(2, "markdown-linux-amd64.zip", changed),
      ]),
      fetchAsset,
    });

    expect(result.issues.some((issue) => issue.code === "version_conflict")).toBe(
      true,
    );
    const [row] = await db
      .select()
      .from(releaseVersions)
      .where(eq(releaseVersions.version, "1.4.2"));
    expect(row?.state).toBe("needs_attention");
  });

  test("rejects a checksum mismatch", async () => {
    const pluginZip = await makeZip({
      "sforum.extension.json": JSON.stringify(pluginManifest),
      "backend/plugin": elfHeader(),
    });
    const badSums = Buffer.from(
      `${"0".repeat(64)}  markdown-linux-amd64.zip\n`,
    );
    fixtures.set("checksums.txt", badSums);

    const result = await syncRelease({
      db,
      repoId: REPO,
      release: release(10, "v1.5.0", [
        asset(3, "checksums.txt", badSums),
        asset(4, "markdown-linux-amd64.zip", pluginZip),
      ]),
      fetchAsset,
    });

    expect(result.issues.some((issue) => issue.code === "digest_mismatch")).toBe(
      true,
    );
    expect(result.versions).toBe(0);
  });
});

describe("auto-publish policy", () => {
  const MARKDOWN = "sforum.markdown-plus";

  async function markdownId(): Promise<string> {
    const [row] = await db
      .select()
      .from(products)
      .where(eq(products.extensionId, MARKDOWN));
    if (!row) throw new Error("markdown product missing");
    return row.id;
  }

  async function approve(productId: string, name: string): Promise<void> {
    await db
      .update(products)
      .set({
        status: "published",
        repoId: 4242,
        nameAtReview: name,
        repoIdReviewed: 4242,
        capabilitiesReviewed: ["host.api"],
        publishedAt: new Date(),
      })
      .where(eq(products.id, productId));
  }

  async function syncPlugin(
    version: string,
    releaseId: number,
    manifestName?: string,
  ): Promise<string> {
    const manifest = {
      ...pluginManifest,
      version,
      ...(manifestName === undefined ? {} : { name: manifestName }),
    };
    const zip = await makeZip({
      "sforum.extension.json": JSON.stringify(manifest),
      "backend/plugin": elfHeader(),
    });
    const name = `markdown-${version}.zip`;
    fixtures.set(name, zip);
    await syncRelease({
      db,
      repoId: 4242,
      release: release(releaseId, `v${version}`, [asset(releaseId * 10, name, zip)]),
      fetchAsset,
    });
    return name;
  }

  test("publishes a release that stays inside the approved snapshot", async () => {
    const productId = await markdownId();
    await approve(productId, "Markdown Plus");
    await syncPlugin("1.9.0", 21);

    const [row] = await db
      .select()
      .from(releaseVersions)
      .where(
        and(
          eq(releaseVersions.productId, productId),
          eq(releaseVersions.version, "1.9.0"),
        ),
      );
    expect(row?.state).toBe("published");
    expect(row?.publishedAt).not.toBeNull();

    // The machine decision is on the timeline, otherwise the admin console's "recent
    // decisions" list would make every publish look like a human one.
    const [event] = await db
      .select()
      .from(moderationEvents)
      .where(
        and(
          eq(moderationEvents.releaseVersionId, row!.id),
          eq(moderationEvents.action, "auto_published"),
        ),
      );
    expect(event?.reason).toBe("approved");
    expect(event?.toState).toBe("published");
  });

  test("holds a release that declares a capability nobody reviewed", async () => {
    const productId = await markdownId();
    const manifest = {
      ...pluginManifest,
      version: "1.6.0",
      capabilities: ["host.api", "net.outbound"],
    };
    const zip = await makeZip({
      "sforum.extension.json": JSON.stringify(manifest),
      "backend/plugin": elfHeader(),
    });
    fixtures.set("markdown-1.6.0.zip", zip);

    await syncRelease({
      db,
      repoId: 4242,
      release: release(22, "v1.6.0", [asset(220, "markdown-1.6.0.zip", zip)]),
      fetchAsset,
    });

    const [row] = await db
      .select()
      .from(releaseVersions)
      .where(
        and(
          eq(releaseVersions.productId, productId),
          eq(releaseVersions.version, "1.6.0"),
        ),
      );
    expect(row?.state).toBe("pending_review");

    const events = await db
      .select()
      .from(moderationEvents)
      .where(eq(moderationEvents.releaseVersionId, row!.id));
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("re_review_required");
    expect(events[0]?.reason).toBe("unknown_capabilities");
    expect(events[0]?.actorAccountId).toBeNull();
  });

  test("holds every release after the product was renamed", async () => {
    const productId = await markdownId();
    // The default-locale translation is what every read surface prefers, so the rename has
    // to move both rows; `renameProduct` is the only writer that does.
    await db.insert(productTranslations).values({
      productId,
      locale: "zh-CN",
      name: "Markdown Plus",
      summary: "renders markdown",
    });

    // A rename can only arrive with a release now: the manifest owns the display name.
    await syncPlugin("1.7.0", 23, "Markdown Plus Pro");

    const [product] = await db
      .select()
      .from(products)
      .where(eq(products.id, productId));
    expect(product.name).toBe("Markdown Plus Pro");
    const [translation] = await db
      .select()
      .from(productTranslations)
      .where(eq(productTranslations.productId, productId));
    expect(translation.name).toBe("Markdown Plus Pro");

    const [row] = await db
      .select()
      .from(releaseVersions)
      .where(
        and(
          eq(releaseVersions.productId, productId),
          eq(releaseVersions.version, "1.7.0"),
        ),
      );
    expect(row?.state).toBe("pending_review");

    const events = await db
      .select()
      .from(moderationEvents)
      .where(eq(moderationEvents.releaseVersionId, row!.id));
    expect(events[0]?.reason).toBe("renamed_since_review");

    // Every later release stays held until a moderator re-approves the new name.
    await syncPlugin("1.8.0", 24, "Markdown Plus Pro");
    const [next] = await db
      .select()
      .from(releaseVersions)
      .where(
        and(
          eq(releaseVersions.productId, productId),
          eq(releaseVersions.version, "1.8.0"),
        ),
      );
    expect(next?.state).toBe("pending_review");
    const nextEvents = await db
      .select()
      .from(moderationEvents)
      .where(eq(moderationEvents.releaseVersionId, next!.id));
    expect(nextEvents[0]?.reason).toBe("renamed_since_review");
  });
});
