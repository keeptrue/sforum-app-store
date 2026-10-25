import { and, eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";

import type { Db } from "@/db/client";
import {
  githubRepos,
  products,
  releaseAssets,
  releaseVersions,
  repoReleases,
  type ManifestLocaleRow,
} from "@/db/schema";
import {
  checksumFor,
  parseChecksums,
} from "@/lib/detection/checksums";
import {
  detectPlatform,
  type Platform,
} from "@/lib/detection/platform";
import { readExtensionZip } from "@/lib/detection/zip";
import type {
  ExtensionManifest,
  ManifestLocale,
} from "@/lib/detection/manifest";
import { recomputeProductLatestVersions } from "@/lib/products/latest";
import { findTranslation, renameProduct } from "@/lib/products/store";
import { recordModerationEvent } from "@/lib/moderation/events";
import { decideReleaseState } from "@/lib/moderation/policy";
import type { GithubRelease, GithubReleaseAsset } from "./client";
import type { DownloadedAsset } from "./assets";
import { recordClaim } from "./claims";

export type AssetFetcher = (
  asset: GithubReleaseAsset,
) => Promise<DownloadedAsset>;

/**
 * `langs` overrides as stored: localized display fields only. Author email is validated by
 * the manifest parser but never persisted — the store has no use for contact details and
 * the public API must not grow a field that would leak them.
 */
function storedLangs(
  langs: Record<string, ManifestLocale>,
): Record<string, ManifestLocaleRow> {
  const stored: Record<string, ManifestLocaleRow> = {};
  for (const [code, locale] of Object.entries(langs)) {
    const author: ManifestLocaleRow["author"] = {};
    if (locale.author?.name) author.name = locale.author.name;
    if (locale.author?.url) author.url = locale.author.url;
    stored[code] = {
      ...(locale.name ? { name: locale.name } : {}),
      ...(locale.description ? { description: locale.description } : {}),
      ...(locale.url ? { url: locale.url } : {}),
      ...(Object.keys(author).length > 0 ? { author } : {}),
    };
  }
  return stored;
}

export type SyncIssue = {
  code: string;
  detail?: string;
};

export type SyncResult = {
  repoReleaseId: string;
  versions: number;
  assets: number;
  issues: SyncIssue[];
  /** Every product this release wrote to; the brand refresh fans out over it. */
  productIds: string[];
};

type Candidate = {
  asset: GithubReleaseAsset;
  downloaded: DownloadedAsset;
  manifest: ExtensionManifest;
  platform: Platform;
};

/**
 * Decide what a manifest id means for this repository before anything is written.
 *
 * - `bound`: the product exists and points at this repository — the only case that syncs.
 * - `unclaimed`: no product owns the id yet, so the release becomes a claim.
 * - `unbound`: a product owns the id but has no repository, so the developer must bind one.
 * - `mismatch`: the id belongs to a different repository; versions never cross repositories.
 *
 * None of these paths create or re-bind a product. Ownership comes from the binding flow,
 * not from whichever installation happened to deliver the release.
 */
type ProductResolution =
  | { kind: "bound"; product: typeof products.$inferSelect }
  | { kind: "unclaimed" }
  | { kind: "unbound"; product: typeof products.$inferSelect }
  | { kind: "mismatch"; product: typeof products.$inferSelect };

async function resolveProduct(
  db: Db,
  input: { extensionId: string; repoId: number },
): Promise<ProductResolution> {
  const [existing] = await db
    .select()
    .from(products)
    .where(eq(products.extensionId, input.extensionId))
    .limit(1);

  if (!existing) return { kind: "unclaimed" };
  if (existing.repoId === null) return { kind: "unbound", product: existing };
  if (existing.repoId !== input.repoId) {
    return { kind: "mismatch", product: existing };
  }
  return { kind: "bound", product: existing };
}

/** Issue code for a release that cannot be written to a product. */
function claimIssueCode(kind: "unclaimed" | "unbound" | "mismatch"): string {
  if (kind === "unclaimed") return "product_unclaimed";
  if (kind === "unbound") return "repo_bind_pending";
  return "repo_mismatch";
}

async function findInstallationId(
  db: Db,
  repoId: number,
): Promise<number | null> {
  const [row] = await db
    .select({ installationId: githubRepos.installationId })
    .from(githubRepos)
    .where(eq(githubRepos.repoId, repoId))
    .limit(1);
  return row?.installationId ?? null;
}

async function loadChecksums(
  release: GithubRelease,
  fetchAsset: AssetFetcher,
): Promise<Map<string, string>> {
  const asset = release.assets.find((item) =>
    /^(checksums\.txt|sha256sums)$/i.test(item.name),
  );
  if (!asset) return new Map();

  const downloaded = await fetchAsset(asset);
  try {
    return parseChecksums(await readFile(downloaded.path, "utf8"));
  } finally {
    await downloaded.cleanup();
  }
}

export async function syncRelease(input: {
  db: Db;
  repoId: number;
  /**
   * The installation the release came from. Optional because a caller may already know it
   * (the webhook job does); when omitted it is read from the repository row. A claim cannot
   * be recorded without it.
   */
  installationId?: number;
  release: GithubRelease;
  fetchAsset: AssetFetcher;
}): Promise<SyncResult> {
  const { db, repoId, release, fetchAsset } = input;
  const issues: SyncIssue[] = [];
  const installationId =
    input.installationId ?? (await findInstallationId(db, repoId));

  const [repoRelease] = await db
    .insert(repoReleases)
    .values({
      repoId,
      githubReleaseId: release.id,
      tag: release.tag_name,
      targetCommitish: release.target_commitish,
      isPrerelease: release.prerelease,
      body: release.body,
      syncState: "syncing",
    })
    .onConflictDoUpdate({
      target: [repoReleases.repoId, repoReleases.githubReleaseId],
      set: {
        tag: release.tag_name,
        targetCommitish: release.target_commitish,
        isPrerelease: release.prerelease,
        body: release.body,
        syncState: "syncing",
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!repoRelease) throw new Error("repo release upsert returned no row");

  const zipAssets = release.assets.filter((asset) =>
    asset.name.toLowerCase().endsWith(".zip"),
  );
  if (zipAssets.length === 0) {
    await db
      .update(repoReleases)
      .set({
        syncState: "needs_attention",
        syncError: "no_zip_assets",
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(repoReleases.id, repoRelease.id));
    return {
      repoReleaseId: repoRelease.id,
      versions: 0,
      assets: 0,
      issues: [{ code: "no_zip_assets" }],
      productIds: [],
    };
  }

  const checksums = await loadChecksums(release, fetchAsset);
  const groups = new Map<string, Candidate[]>();

  for (const asset of zipAssets) {
    let downloaded: DownloadedAsset | null = null;
    try {
      downloaded = await fetchAsset(asset);
      const expected = checksumFor(checksums, asset.name);
      if (expected && expected !== downloaded.sha256) {
        issues.push({ code: "digest_mismatch", detail: asset.name });
        continue;
      }

      const zip = await readExtensionZip(downloaded.path);
      const platform = detectPlatform({
        manifest: zip.manifest,
        backend: zip.backend,
        filename: asset.name,
      });
      if (!platform) {
        issues.push({ code: "platform_unknown", detail: asset.name });
        continue;
      }

      const list = groups.get(zip.manifest.id) ?? [];
      list.push({ asset, downloaded, manifest: zip.manifest, platform });
      groups.set(zip.manifest.id, list);
    } catch (error) {
      issues.push({
        code:
          error instanceof Error && "code" in error
            ? String((error as { code?: string }).code)
            : "asset_failed",
        detail: asset.name,
      });
    } finally {
      if (downloaded) await downloaded.cleanup();
    }
  }

  let versionCount = 0;
  let assetCount = 0;
  // Materialized latest-versions must follow any published <-> needs_attention move.
  const touchedProducts = new Set<string>();
  // Every product this release actually wrote to, published version or not: the brand
  // refresh runs per product, and a release is a signal that the repository moved.
  const syncedProducts = new Set<string>();

  for (const [extensionId, candidates] of groups) {
    const [first] = candidates;
    if (
      candidates.some(
        (item) =>
          item.manifest.version !== first.manifest.version ||
          item.manifest.type !== first.manifest.type,
      )
    ) {
      issues.push({ code: "manifest_mismatch", detail: extensionId });
      continue;
    }

    const seenPlatforms = new Set<string>();
    const duplicatePlatform = candidates.some((item) => {
      const key = `${item.platform.os}/${item.platform.arch}`;
      if (seenPlatforms.has(key)) return true;
      seenPlatforms.add(key);
      return false;
    });

    const resolution = await resolveProduct(db, { extensionId, repoId });
    if (resolution.kind !== "bound") {
      // Nothing is written to `products` here. An unowned id becomes a claim the developer
      // accepts by importing or claiming the repository; a product that already exists but
      // points elsewhere is only reported, because a claim on someone else's product would
      // put an unanswerable row in the queue.
      if (resolution.kind === "unclaimed") {
        if (installationId === null) {
          issues.push({ code: "repo_unknown", detail: extensionId });
          continue;
        }
        await recordClaim(db, {
          repoId,
          installationId,
          extensionId,
          manifestName: first.manifest.name,
          tag: release.tag_name,
          githubReleaseId: release.id,
        });
      }
      issues.push({
        code: claimIssueCode(resolution.kind),
        detail: extensionId,
      });
      continue;
    }

    let product = resolution.product;

    // The manifest owns the display name. A rename is applied here (not by a PATCH) so the
    // name a moderator approved and the name a release ships can only diverge through
    // `name_at_review`, which `decideReleaseState` already holds on.
    if (first.manifest.name !== product.name) {
      const renamed = await renameProduct(
        db,
        product.id,
        product.defaultLocale,
        first.manifest.name,
      );
      if (renamed) product = renamed;
    }

    syncedProducts.add(product.id);

    const version = first.manifest.version;
    const channel =
      release.prerelease || version.includes("-") ? "beta" : "stable";

    const [existing] = await db
      .select()
      .from(releaseVersions)
      .where(
        and(
          eq(releaseVersions.productId, product.id),
          eq(releaseVersions.version, version),
        ),
      )
      .limit(1);

    if (existing) {
      const existingAssets = await db
        .select()
        .from(releaseAssets)
        .where(eq(releaseAssets.releaseVersionId, existing.id));
      const same =
        existingAssets.length === candidates.length &&
        candidates.every((item) =>
          existingAssets.some(
            (asset) =>
              asset.os === item.platform.os &&
              asset.arch === item.platform.arch &&
              asset.sha256 === item.downloaded.sha256,
          ),
        );
      if (!same) {
        await db
          .update(releaseVersions)
          .set({
            state: "needs_attention",
            detectionIssue: { code: "version_conflict", extensionId },
            updatedAt: new Date(),
          })
          .where(eq(releaseVersions.id, existing.id));
        if (existing.state === "published") touchedProducts.add(product.id);
        issues.push({ code: "version_conflict", detail: `${extensionId}@${version}` });
      }
      continue;
    }

    // Auto-publish policy (plan §7.4 items 12–14): a first release is always reviewed;
    // afterwards a release may publish itself only while the product is unchanged.
    // `needs_attention` still wins over everything: detection problems are never published.
    const translation = await findTranslation(db, product.id, product.defaultLocale);
    const displayName = translation?.name ?? product.name;
    const decision = decideReleaseState({
      productStatus: product.status,
      productName: displayName,
      nameAtReview: product.nameAtReview,
      repoId: product.repoId,
      repoIdReviewed: product.repoIdReviewed,
      capabilitiesReviewed: product.capabilitiesReviewed,
      versionCapabilities: first.manifest.capabilities,
    });
    const state =
      duplicatePlatform || issues.length > 0 ? "needs_attention" : decision.state;

    const [versionRow] = await db
      .insert(releaseVersions)
      .values({
        productId: product.id,
        repoReleaseId: repoRelease.id,
        version,
        channel,
        state,
        sforumVersionConstraint: first.manifest.sforumVersion,
        capabilities: first.manifest.capabilities,
        manifestDescription: first.manifest.description,
        manifestUrl: first.manifest.url,
        manifestAuthorName: first.manifest.author.name,
        manifestAuthorUrl: first.manifest.author.url ?? null,
        manifestLangs: storedLangs(first.manifest.langs),
        notesMd: release.body,
        publishedAt: state === "published" ? new Date() : null,
        detectionIssue: duplicatePlatform
          ? { code: "duplicate_platform", extensionId }
          : null,
      })
      .returning();

    if (!versionRow) continue;
    versionCount += 1;
    if (versionRow.state === "published") touchedProducts.add(product.id);

    // A published product that gets a held version is exactly the re-review bucket the
    // moderator console lists; the reason is recorded for the timeline.
    if (decision.state === "pending_review" && product.status === "published") {
      await recordModerationEvent(db, {
        releaseVersionId: versionRow.id,
        action: "re_review_required",
        fromState: null,
        toState: "pending_review",
        reason: decision.reason,
      });
    } else if (versionRow.state === "published" && decision.state === "published") {
      // Auto-publish used to leave no trace at all, which made the admin console's "recent
      // decisions" list look like every publish was a human one. Record the machine decision
      // with the same reason vocabulary the hold path uses.
      await recordModerationEvent(db, {
        releaseVersionId: versionRow.id,
        action: "auto_published",
        fromState: null,
        toState: "published",
        reason: decision.reason,
      });
    }

    for (const item of candidates) {
      await db
        .insert(releaseAssets)
        .values({
          releaseVersionId: versionRow.id,
          os: item.platform.os,
          arch: item.platform.arch,
          filename: item.asset.name,
          size: item.downloaded.size,
          sha256: item.downloaded.sha256,
          upstreamAssetId: item.asset.id,
          detectionSource: item.platform.source,
        })
        .onConflictDoNothing();
      assetCount += 1;
    }
  }

  for (const productId of touchedProducts) {
    await recomputeProductLatestVersions(db, productId);
  }

  await db
    .update(repoReleases)
    .set({
      syncState: issues.length > 0 ? "needs_attention" : "synced",
      syncError:
        issues.length > 0 ? JSON.stringify(issues).slice(0, 2000) : null,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(repoReleases.id, repoRelease.id));

  return {
    repoReleaseId: repoRelease.id,
    versions: versionCount,
    assets: assetCount,
    issues,
    productIds: [...syncedProducts],
  };
}
