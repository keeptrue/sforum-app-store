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
  repoReleases,
  webhookDeliveries,
} from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import { ZipDetectionError } from "@/lib/detection/zip";
import {
  elfHeader,
  makeZip,
  pluginManifest,
  themeManifest,
} from "../../../test/zip-fixture";
import type { GithubRelease, GithubReleaseAsset } from "./client";
import { AssetFetchError } from "./assets";
import { markWebhookDelivery, recordWebhookDelivery } from "./deliveries";
import { syncRelease, isRetryableFailure, type AssetFetcher } from "./sync";
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

  test("a delivery that fails once and then succeeds ends up processed", async () => {
    // The worker marks `failed` and rethrows on every attempt; pg-boss retries the same job,
    // so the same delivery row is written twice. The second write has to clear the first.
    const deliveryId = "delivery-retry-1";
    expect(
      await recordWebhookDelivery(db, {
        deliveryId,
        event: "release",
        action: "published",
        payload: { action: "published" },
      }),
    ).toBe(true);

    await markWebhookDelivery(
      db,
      deliveryId,
      "failed",
      "asset_fetch_failed (503): asset download failed: 503",
    );
    await markWebhookDelivery(db, deliveryId, "processed");

    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, deliveryId));
    expect(row?.status).toBe("processed");
    expect(row?.error).toBeNull();
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

  // §10 Q3: a tag carries N extensions, so one broken package must not decide the fate of
  // the others. `release_versions.state` follows the extension's own issues; the release row
  // keeps reporting the whole tag.
  describe("issue attribution", () => {
    const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

    async function versionRowFor(repoReleaseId: string, productId: string) {
      const rows = await db
        .select()
        .from(releaseVersions)
        .where(eq(releaseVersions.repoReleaseId, repoReleaseId));
      return rows.find((row) => row.productId === productId);
    }

    test("isolates a digest mismatch to the extension that shipped it", async () => {
      const isoA = "sforum.iso-a";
      const isoB = "sforum.iso-b";
      const aId = await ensureProduct({ extensionId: isoA, name: "Iso A" });
      const bId = await ensureProduct({
        extensionId: isoB,
        name: "Iso B",
        kind: "theme",
      });

      const aAmd64 = await makeZip({
        "sforum.extension.json": JSON.stringify({ ...pluginManifest, id: isoA }),
        "backend/plugin": elfHeader(0x3e),
      });
      const aArm64 = await makeZip({
        "sforum.extension.json": JSON.stringify({ ...pluginManifest, id: isoA }),
        "backend/plugin": elfHeader(0xb7),
      });
      const bTheme = await makeZip({
        "sforum.extension.json": JSON.stringify({ ...themeManifest, id: isoB }),
      });

      // The classic case: one platform was rebuilt, `checksums.txt` was not refreshed.
      const sums = Buffer.from(
        [
          `${sha(aAmd64)}  iso-a-linux-amd64.zip`,
          `${"0".repeat(64)}  iso-a-linux-arm64.zip`,
          `${sha(bTheme)}  iso-b-any.zip`,
        ].join("\n") + "\n",
      );
      fixtures.set("checksums.txt", sums);
      fixtures.set("iso-a-linux-amd64.zip", aAmd64);
      fixtures.set("iso-a-linux-arm64.zip", aArm64);
      fixtures.set("iso-b-any.zip", bTheme);

      const result = await syncRelease({
        db,
        repoId: REPO,
        release: release(30, "v2.0.0", [
          asset(300, "checksums.txt", sums),
          asset(301, "iso-a-linux-amd64.zip", aAmd64),
          asset(302, "iso-a-linux-arm64.zip", aArm64),
          asset(303, "iso-b-any.zip", bTheme),
        ]),
        fetchAsset,
      });

      // A's arm64 build is still rejected — attribution only decides who gets held.
      expect(result.assets).toBe(2);
      expect(result.issues.map((issue) => issue.code)).toEqual([
        "digest_mismatch",
      ]);

      expect((await versionRowFor(result.repoReleaseId, aId))?.state).toBe(
        "needs_attention",
      );
      expect((await versionRowFor(result.repoReleaseId, bId))?.state).toBe(
        "pending_review",
      );

      // The tag itself is still flagged: someone has to look at the broken asset.
      const [releaseRow] = await db
        .select()
        .from(repoReleases)
        .where(eq(repoReleases.id, result.repoReleaseId));
      expect(releaseRow?.syncState).toBe("needs_attention");
      expect(releaseRow?.syncError).toContain("digest_mismatch");
    });

    test("holds the whole tag when a broken asset cannot be attributed", async () => {
      const isoC = "sforum.iso-c";
      const isoD = "sforum.iso-d";
      await ensureProduct({ extensionId: isoC, name: "Iso C" });
      const dId = await ensureProduct({
        extensionId: isoD,
        name: "Iso D",
        kind: "theme",
      });

      // Neither archive yields a manifest id: one is unreadable garbage that also fails its
      // checksum, the other is garbage with no checksum entry at all (`asset_failed`).
      const corrupt = Buffer.from("this is not a zip archive");
      const unparseable = Buffer.from("neither is this one");
      const dTheme = await makeZip({
        "sforum.extension.json": JSON.stringify({ ...themeManifest, id: isoD }),
      });
      const sums = Buffer.from(`${"0".repeat(64)}  iso-c-broken.zip\n`);
      fixtures.set("checksums.txt", sums);
      fixtures.set("iso-c-broken.zip", corrupt);
      fixtures.set("iso-e-broken.zip", unparseable);
      fixtures.set("iso-d-any.zip", dTheme);

      const result = await syncRelease({
        db,
        repoId: REPO,
        release: release(31, "v2.1.0", [
          asset(310, "checksums.txt", sums),
          asset(311, "iso-c-broken.zip", corrupt),
          asset(312, "iso-e-broken.zip", unparseable),
          asset(313, "iso-d-any.zip", dTheme),
        ]),
        fetchAsset,
      });

      // Both failures stay in the flat log, unattributed.
      expect(result.issues.map((issue) => issue.detail).sort()).toEqual([
        "iso-c-broken.zip",
        "iso-e-broken.zip",
      ]);
      expect(result.issues[0]?.code).toBe("digest_mismatch");

      // Documented fallback: an unattributable issue holds every version in the release,
      // because we cannot prove the innocent-looking sibling shipped complete bytes.
      expect((await versionRowFor(result.repoReleaseId, dId))?.state).toBe(
        "needs_attention",
      );
    });

    test("does not let an unclaimed extension hold a bound one in the same tag", async () => {
      const isoF = "sforum.iso-f";
      const stranger = "sforum.iso-stranger";
      const fId = await ensureProduct({ extensionId: isoF, name: "Iso F" });

      const fZip = await makeZip({
        "sforum.extension.json": JSON.stringify({ ...pluginManifest, id: isoF }),
        "backend/plugin": elfHeader(),
      });
      const strangerZip = await makeZip({
        "sforum.extension.json": JSON.stringify({
          ...pluginManifest,
          id: stranger,
        }),
        "backend/plugin": elfHeader(),
      });
      fixtures.set("iso-f-linux-amd64.zip", fZip);
      fixtures.set("iso-stranger-linux-amd64.zip", strangerZip);

      const result = await syncRelease({
        db,
        repoId: REPO,
        installationId: 77,
        release: release(32, "v2.2.0", [
          // The unclaimed package comes first on purpose: group order is asset order, so
          // this is the arrangement where a shared issue list used to leak into F.
          asset(320, "iso-stranger-linux-amd64.zip", strangerZip),
          asset(321, "iso-f-linux-amd64.zip", fZip),
        ]),
        fetchAsset,
      });

      expect(result.issues.map((issue) => issue.code)).toEqual([
        "product_unclaimed",
      ]);
      const claims = await db
        .select()
        .from(repoClaims)
        .where(eq(repoClaims.extensionId, stranger));
      expect(claims).toHaveLength(1);

      // The unclaimed id produces no version row, and its issue does not reach F.
      expect((await versionRowFor(result.repoReleaseId, fId))?.state).toBe(
        "pending_review",
      );
      const [releaseRow] = await db
        .select()
        .from(repoReleases)
        .where(eq(repoReleases.id, result.repoReleaseId));
      expect(releaseRow?.syncState).toBe("needs_attention");
    });
  });

  // A transient GitHub failure must not reach the version rows: `needs_attention` is terminal,
  // so the old behaviour (record `asset_failed`, hold the tag) burned version numbers on a 500.
  describe("transient failures", () => {
    async function releaseRowFor(githubReleaseId: number) {
      const [row] = await db
        .select()
        .from(repoReleases)
        .where(
          and(
            eq(repoReleases.repoId, REPO),
            eq(repoReleases.githubReleaseId, githubReleaseId),
          ),
        );
      return row;
    }

    test("aborts on a retryable failure instead of burning the tag", async () => {
      const id = "sforum.retry-a";
      await ensureProduct({ extensionId: id, name: "Retry A" });
      const zip = await makeZip({
        "sforum.extension.json": JSON.stringify({ ...pluginManifest, id }),
        "backend/plugin": elfHeader(),
      });

      await expect(
        syncRelease({
          db,
          repoId: REPO,
          release: release(50, "v3.0.0", [
            asset(500, "retry-a-linux-amd64.zip", zip),
          ]),
          fetchAsset: async () => {
            throw new AssetFetchError("asset download failed: 503", {
              retryable: true,
              status: 503,
            });
          },
        }),
      ).rejects.toThrow("503");

      // The row must not be left `syncing`: that is indistinguishable from a sync in flight.
      const row = await releaseRowFor(50);
      expect(row?.syncState).toBe("failed");
      expect(row?.syncError).toContain("asset_fetch_failed");
      expect(row?.syncError).toContain("503");

      // Nothing was written, so the retry starts from a clean release.
      const versions = await db
        .select()
        .from(releaseVersions)
        .where(eq(releaseVersions.repoReleaseId, row!.id));
      expect(versions).toHaveLength(0);
    });

    test("records a non-retryable failure instead of retrying it", async () => {
      const id = "sforum.gone-a";
      const productId = await ensureProduct({ extensionId: id, name: "Gone A" });
      const zip = await makeZip({
        "sforum.extension.json": JSON.stringify({ ...pluginManifest, id }),
        "backend/plugin": elfHeader(0x3e),
      });
      fixtures.set("gone-a-linux-amd64.zip", zip);

      const result = await syncRelease({
        db,
        repoId: REPO,
        release: release(51, "v3.1.0", [
          asset(510, "gone-a-linux-arm64.zip", Buffer.from("never fetched")),
          asset(511, "gone-a-linux-amd64.zip", zip),
        ]),
        fetchAsset: async (item) => {
          if (item.name === "gone-a-linux-arm64.zip") {
            throw new AssetFetchError("asset download failed: 404", {
              retryable: false,
              status: 404,
            });
          }
          return fetchAsset(item);
        },
      });

      // A 404 is a verdict: the asset is gone, so the retry would read the same answer.
      expect(result.issues.map((issue) => issue.code)).toEqual(["asset_failed"]);
      const row = await releaseRowFor(51);
      expect(row?.syncState).toBe("needs_attention");
      expect(row?.syncError).toContain("asset_failed");

      // The surviving platform still produced a row, and it is held.
      const [version] = await db
        .select()
        .from(releaseVersions)
        .where(
          and(
            eq(releaseVersions.productId, productId),
            eq(releaseVersions.version, "1.4.2"),
          ),
        );
      expect(version?.state).toBe("needs_attention");
    });
  });

  // §Q4: a published version whose bytes changed must be reported even when the same tag also
  // carries another version of the same extension — the group-level early return used to
  // swallow it.
  test("reports a version conflict even when the group's manifests disagree", async () => {
    const id = "sforum.split";
    const productId = await ensureProduct({ extensionId: id, name: "Split" });
    await db
      .update(products)
      .set({
        status: "published",
        repoId: REPO,
        nameAtReview: "Split",
        repoIdReviewed: REPO,
        capabilitiesReviewed: ["host.api"],
        publishedAt: new Date(),
      })
      .where(eq(products.id, productId));

    const v100 = await makeZip({
      "sforum.extension.json": JSON.stringify({
        ...pluginManifest,
        id,
        name: "Split",
        version: "1.0.0",
      }),
      "backend/plugin": elfHeader(),
    });
    fixtures.set("split-1.0.0-linux-amd64.zip", v100);
    await syncRelease({
      db,
      repoId: REPO,
      release: release(52, "v4.0.0", [
        asset(520, "split-1.0.0-linux-amd64.zip", v100),
      ]),
      fetchAsset,
    });

    const [published] = await db
      .select()
      .from(releaseVersions)
      .where(
        and(
          eq(releaseVersions.productId, productId),
          eq(releaseVersions.version, "1.0.0"),
        ),
      );
    expect(published?.state).toBe("published");
    const before = await db
      .select()
      .from(releaseAssets)
      .where(eq(releaseAssets.releaseVersionId, published!.id));
    expect(before).toHaveLength(1);

    // The same tag now claims two versions of one extension, and the 1.0.0 package differs
    // from the one already published.
    const v100changed = await makeZip({
      "sforum.extension.json": JSON.stringify({
        ...pluginManifest,
        id,
        name: "Split",
        version: "1.0.0",
      }),
      "backend/plugin": Buffer.concat([elfHeader(), Buffer.from("changed")]),
    });
    const v110 = await makeZip({
      "sforum.extension.json": JSON.stringify({
        ...pluginManifest,
        id,
        name: "Split",
        version: "1.1.0",
      }),
      "backend/plugin": elfHeader(),
    });
    fixtures.set("split-1.0.0-linux-amd64.zip", v100changed);
    fixtures.set("split-1.1.0-linux-amd64.zip", v110);

    const result = await syncRelease({
      db,
      repoId: REPO,
      release: release(53, "v4.0.0-split", [
        asset(530, "split-1.0.0-linux-amd64.zip", v100changed),
        asset(531, "split-1.1.0-linux-amd64.zip", v110),
      ]),
      fetchAsset,
    });

    expect(result.issues.map((issue) => issue.code).sort()).toEqual([
      "manifest_mismatch",
      "version_conflict",
    ]);
    const row = await db
      .select()
      .from(repoReleases)
      .where(eq(repoReleases.id, result.repoReleaseId));
    expect(row[0]?.syncError).toContain("manifest_mismatch");
    expect(row[0]?.syncError).toContain("version_conflict");

    // Report only: the published version keeps its state and its bytes.
    const [after] = await db
      .select()
      .from(releaseVersions)
      .where(eq(releaseVersions.id, published!.id));
    expect(after?.state).toBe("published");
    const afterAssets = await db
      .select()
      .from(releaseAssets)
      .where(eq(releaseAssets.releaseVersionId, published!.id));
    expect(afterAssets.map((item) => item.sha256)).toEqual([
      before[0]!.sha256,
    ]);
  });

  // A retry after a partial write used to be the trap: the version row survived, the asset
  // rows did not, and the retry read that as a digest change — the very `needs_attention`
  // this path exists to avoid.
  test("rolls the version row back when the asset insert fails", async () => {
    const id = "sforum.atomic";
    const productId = await ensureProduct({ extensionId: id, name: "Atomic" });
    await db
      .update(products)
      .set({
        status: "published",
        repoId: REPO,
        nameAtReview: "Atomic",
        repoIdReviewed: REPO,
        capabilitiesReviewed: ["host.api"],
        publishedAt: new Date(),
      })
      .where(eq(products.id, productId));

    const zip = await makeZip({
      "sforum.extension.json": JSON.stringify({
        ...pluginManifest,
        id,
        name: "Atomic",
      }),
      "backend/plugin": elfHeader(),
    });
    fixtures.set("atomic-linux-amd64.zip", zip);

    const eventsBefore = await db.select().from(moderationEvents);

    // `release_assets.size` is a bigint column, so this overflows it *after* the version row
    // and its moderation event have been written and before the asset row lands.
    await expect(
      syncRelease({
        db,
        repoId: REPO,
        release: release(60, "v5.0.0", [
          asset(600, "atomic-linux-amd64.zip", zip),
        ]),
        fetchAsset: async (item) => ({
          ...(await fetchAsset(item)),
          size: 2 ** 63,
        }),
      }),
    ).rejects.toThrow();

    const leftovers = await db
      .select()
      .from(releaseVersions)
      .where(
        and(
          eq(releaseVersions.productId, productId),
          eq(releaseVersions.version, "1.4.2"),
        ),
      );
    expect(leftovers).toHaveLength(0);
    expect(await db.select().from(moderationEvents)).toHaveLength(
      eventsBefore.length,
    );

    // The retry is a clean insert, not a conflict, and it publishes.
    const result = await syncRelease({
      db,
      repoId: REPO,
      release: release(60, "v5.0.0", [
        asset(600, "atomic-linux-amd64.zip", zip),
      ]),
      fetchAsset,
    });
    expect(result.issues).toEqual([]);
    const [row] = await db
      .select()
      .from(releaseVersions)
      .where(eq(releaseVersions.repoReleaseId, result.repoReleaseId));
    expect(row?.state).toBe("published");
  });

  test("aborts when the archive cannot be read from local disk", async () => {
    const id = "sforum.io-a";
    await ensureProduct({ extensionId: id, name: "IO A" });
    const missing = join(tmpdir(), `sforum-missing-${Date.now()}`, "asset.zip");

    // The bytes never reach the parser: this is the worker's disk failing, not a bad package.
    await expect(
      syncRelease({
        db,
        repoId: REPO,
        release: release(61, "v6.0.0", [
          asset(610, "io-a-linux-amd64.zip", Buffer.from("never read")),
        ]),
        fetchAsset: async () => ({
          path: missing,
          sha256: "0".repeat(64),
          size: 10,
          cleanup: async () => {},
        }),
      }),
    ).rejects.toThrow();

    const [row] = await db
      .select()
      .from(repoReleases)
      .where(
        and(
          eq(repoReleases.repoId, REPO),
          eq(repoReleases.githubReleaseId, 61),
        ),
      );
    expect(row?.syncState).toBe("failed");
    expect(row?.syncError).toContain("ENOENT");
    const versions = await db
      .select()
      .from(releaseVersions)
      .where(eq(releaseVersions.repoReleaseId, row!.id));
    expect(versions).toHaveLength(0);
  });

  // The webhook is at-least-once, so two jobs can run the same release. The loser's failure
  // writeback must not land on top of a `synced` the winner already committed.
  test("a losing attempt does not overwrite a finished sync", async () => {
    const id = "sforum.race";
    await ensureProduct({ extensionId: id, name: "Race" });
    const zip = await makeZip({
      "sforum.extension.json": JSON.stringify({
        ...pluginManifest,
        id,
        name: "Race",
      }),
      "backend/plugin": elfHeader(),
    });
    fixtures.set("race-linux-amd64.zip", zip);

    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let loserReachedAssets: () => void = () => {};
    const reached = new Promise<void>((resolve) => {
      loserReachedAssets = resolve;
    });

    // The loser commits `syncing` in its upsert and then blocks in the asset stage, so the
    // winner below is guaranteed to run against a row that is already `syncing`.
    const loser = syncRelease({
      db,
      repoId: REPO,
      release: release(70, "v7.0.0", [
        asset(700, "race-linux-amd64.zip", zip),
      ]),
      fetchAsset: async () => {
        loserReachedAssets();
        await gate;
        throw new AssetFetchError("asset download failed: 503", {
          retryable: true,
          status: 503,
        });
      },
    });
    loser.catch(() => {});

    await reached;
    await syncRelease({
      db,
      repoId: REPO,
      release: release(70, "v7.0.0", [
        asset(700, "race-linux-amd64.zip", zip),
      ]),
      fetchAsset,
    });

    // The winner is done; only now does the loser's failure writeback run.
    openGate();
    await expect(loser).rejects.toThrow("503");

    const [row] = await db
      .select()
      .from(repoReleases)
      .where(
        and(
          eq(repoReleases.repoId, REPO),
          eq(repoReleases.githubReleaseId, 70),
        ),
      );
    expect(row?.syncState).toBe("synced");
  });
});

describe("isRetryableFailure", () => {
  test("separates transport and disk hiccups from verdicts about the package", () => {
    expect(
      isRetryableFailure(
        new AssetFetchError("503", { retryable: true, status: 503 }),
      ),
    ).toBe(true);
    expect(
      isRetryableFailure(
        new AssetFetchError("404", { retryable: false, status: 404 }),
      ),
    ).toBe(false);

    for (const code of ["EIO", "EMFILE", "ENOSPC", "ENOENT"]) {
      expect(isRetryableFailure(Object.assign(new Error(code), { code }))).toBe(
        true,
      );
    }

    // A package we could read and judge stays a verdict.
    expect(isRetryableFailure(new ZipDetectionError("manifest_missing"))).toBe(
      false,
    );
    expect(isRetryableFailure(new Error("boom"))).toBe(false);
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
