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
import {
  AssetFetchError,
  isRetryableAssetError,
  type DownloadedAsset,
} from "./assets";
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

/**
 * Release issues are kept in two shapes at once.
 *
 * `all` is the flat log: every issue, in the order it was found. It is what
 * `repo_releases.sync_error` stores and what callers get back, and it stays complete — a
 * release that half-synced has to be diagnosable from one row.
 *
 * The buckets decide the blast radius on `release_versions.state`:
 *
 * - `byExtension` — the package named a manifest id, so only that extension's version row is
 *   held. A broken package in a multi-extension tag no longer holds its siblings (§10 Q3).
 * - `releaseWide` — the issue could not be attributed to any extension, so every version in
 *   this release is held. That is a deliberate default, not an accident: an unattributable
 *   failure means we cannot prove which extension's artifact is missing or corrupt, and
 *   publishing a version with an unverified or incomplete asset set is worse than burning
 *   the version numbers of the whole tag. The bill is real and worth stating plainly:
 *   `needs_attention` is terminal — it never enters the review queue and no code transitions
 *   out of it — so a false hold cannot be cleared by hand, and a patch release is the only
 *   way forward.
 */
type IssueLog = {
  all: SyncIssue[];
  byExtension: Map<string, SyncIssue[]>;
  releaseWide: SyncIssue[];
};

function emptyIssueLog(): IssueLog {
  return { all: [], byExtension: new Map(), releaseWide: [] };
}

/** Record one issue in the flat log and in the bucket that decides who gets held. */
function recordIssue(
  log: IssueLog,
  issue: SyncIssue,
  extensionId: string | null,
): void {
  log.all.push(issue);
  if (extensionId === null) {
    log.releaseWide.push(issue);
    return;
  }
  const bucket = log.byExtension.get(extensionId);
  if (bucket) bucket.push(issue);
  else log.byExtension.set(extensionId, [issue]);
}

/** Issues that hold this extension's version: its own, plus everything unattributable. */
function issuesHolding(log: IssueLog, extensionId: string): SyncIssue[] {
  return [...log.releaseWide, ...(log.byExtension.get(extensionId) ?? [])];
}

/**
 * Does the stored asset set describe exactly these candidates? Same count, and every
 * candidate's platform present with the same digest.
 *
 * Shared by the two places that ask the question — the normal path, which acts on a
 * difference, and the inconsistent-group path, which only reports it — so they can never
 * drift apart on what "the bytes changed" means.
 */
function sameAssetSet(
  stored: { os: string; arch: string; sha256: string }[],
  candidates: Candidate[],
): boolean {
  return (
    stored.length === candidates.length &&
    candidates.every((item) =>
      stored.some(
        (asset) =>
          asset.os === item.platform.os &&
          asset.arch === item.platform.arch &&
          asset.sha256 === item.downloaded.sha256,
      ),
    )
  );
}

/**
 * Report, per version, that an inconsistent group disagrees with what is already stored.
 *
 * Reporting only, and deliberately so: the caller has already decided this group cannot be
 * trusted enough to write anything, so its claim about a published version's bytes is not
 * evidence. Nothing here updates `release_versions` — a conflict that could not be trusted as
 * grounds to publish is not trusted as grounds to demote either.
 */
async function reportVersionConflicts(
  db: Db,
  log: IssueLog,
  input: { productId: string; extensionId: string; candidates: Candidate[] },
): Promise<void> {
  const versions = new Set(input.candidates.map((item) => item.manifest.version));
  for (const version of versions) {
    const [existing] = await db
      .select()
      .from(releaseVersions)
      .where(
        and(
          eq(releaseVersions.productId, input.productId),
          eq(releaseVersions.version, version),
        ),
      )
      .limit(1);
    if (!existing) continue;

    const stored = await db
      .select()
      .from(releaseAssets)
      .where(eq(releaseAssets.releaseVersionId, existing.id));
    const sameVersion = input.candidates.filter(
      (item) => item.manifest.version === version,
    );
    if (sameAssetSet(stored, sameVersion)) continue;

    recordIssue(
      log,
      { code: "version_conflict", detail: `${input.extensionId}@${version}` },
      input.extensionId,
    );
  }
}

/**
 * Best-effort: which extension does a package we refused to accept claim to be?
 *
 * Only needed for `digest_mismatch`, where the download itself succeeded and the bytes are
 * already in a temp file — it was the checksum comparison that failed.
 *
 * Reading an archive whose digest does not match its `checksums.txt` entry is acceptable
 * because the answer is used for exactly one thing: choosing how wide to draw the
 * `needs_attention` blast radius. It never installs, never persists, never reaches the
 * catalog and can never publish anything; the asset itself is still rejected. A package
 * that lies about its id can at worst get a sibling held — inside the same repository's
 * release, which the same developer controls.
 *
 * The parse is the accept-path parser, not a looser one, so the bytes still have to look
 * like a package the store would consider installing: safe entry names, manifest at the
 * root, backend entry present. Anything else throws and the caller falls back to the
 * release-wide bucket.
 */
async function claimedExtensionId(path: string): Promise<string | null> {
  try {
    const zip = await readExtensionZip(path);
    return zip.manifest.id;
  } catch {
    return null;
  }
}

type SyncReleaseInput = {
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
};

/** Why a sync aborted, in the one column an operator reads first. */
function failureReason(error: unknown): string {
  if (error instanceof AssetFetchError) {
    const status = error.status === null ? "network" : String(error.status);
    return `asset_fetch_failed (${status}): ${error.message}`.slice(0, 500);
  }
  const message = error instanceof Error ? error.message : String(error);
  return `sync_failed: ${message}`.slice(0, 500);
}

/**
 * Codes that mean "the local filesystem hiccuped", not "this package is broken".
 *
 * By the time an archive is parsed it is already on local disk, so `EIO`/`EMFILE`/`ENOSPC`
 * there is the worker's disk talking, not a verdict about the release. `ENOENT` is in for the
 * same reason: the only file read is the one just written, so a missing one means something
 * cleaned the temp directory underneath us and a retry re-downloads it.
 */
const RETRYABLE_FS_CODES = new Set([
  "EIO",
  "EMFILE",
  "ENFILE",
  "ENOSPC",
  "EAGAIN",
  "EBUSY",
  "ETIMEDOUT",
  "ENOENT",
]);

/**
 * Should this failure abort the sync and be retried, instead of being recorded as an issue?
 *
 * The asymmetry decides the default: a wrong "retry" costs one job attempt, a wrong
 * "permanent" costs every version number in the tag (`needs_attention` is terminal). So the
 * only failures treated as verdicts are the ones positively identified as content problems —
 * a bad ZIP, an invalid manifest, a deleted asset.
 */
export function isRetryableFailure(error: unknown): boolean {
  if (isRetryableAssetError(error)) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && RETRYABLE_FS_CODES.has(code);
}

/**
 * Sync one GitHub release into the catalog.
 *
 * Owns the `repo_releases` row and its failure bookkeeping: whatever the body throws, the row
 * is left `failed` with a reason rather than `syncing`, because `syncing` is indistinguishable
 * from a sync still in flight and nothing sweeps it. A retry re-enters here, the upsert sets
 * `syncing` again, and a successful pass overwrites the failure with `synced` or
 * `needs_attention`.
 */
export async function syncRelease(input: SyncReleaseInput): Promise<SyncResult> {
  const { db, repoId, release } = input;
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

  try {
    return await syncReleaseBody({ ...input, installationId, repoRelease });
  } catch (error) {
    await db
      .update(repoReleases)
      .set({
        syncState: "failed",
        syncError: failureReason(error),
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      // Only while the row is still the `syncing` this attempt wrote. Two jobs can run the
      // same release — the webhook is at-least-once — and the loser must not overwrite a
      // `synced` the winner has already committed: that would leave the release marked failed
      // while its versions are published. Losing the race here is the correct outcome, so a
      // zero-row update is not an error.
      .where(
        and(
          eq(repoReleases.id, repoRelease.id),
          eq(repoReleases.syncState, "syncing"),
        ),
      );
    throw error;
  }
}

async function syncReleaseBody(
  input: Omit<SyncReleaseInput, "installationId"> & {
    /** Resolved by the caller: the job may know it, otherwise it is read from the repo row. */
    installationId: number | null;
    repoRelease: typeof repoReleases.$inferSelect;
  },
): Promise<SyncResult> {
  const { db, repoId, release, fetchAsset, installationId, repoRelease } = input;
  const issueLog = emptyIssueLog();

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
        // The file is on disk, so the manifest can still say whose package this was — see
        // `claimedExtensionId`. Unreadable means release-wide.
        recordIssue(
          issueLog,
          { code: "digest_mismatch", detail: asset.name },
          await claimedExtensionId(downloaded.path),
        );
        continue;
      }

      const zip = await readExtensionZip(downloaded.path);
      const platform = detectPlatform({
        manifest: zip.manifest,
        backend: zip.backend,
        filename: asset.name,
      });
      if (!platform) {
        // The archive parsed, so its manifest id is right here: hold only that extension.
        recordIssue(
          issueLog,
          { code: "platform_unknown", detail: asset.name },
          zip.manifest.id,
        );
        continue;
      }

      const list = groups.get(zip.manifest.id) ?? [];
      list.push({ asset, downloaded, manifest: zip.manifest, platform });
      groups.set(zip.manifest.id, list);
    } catch (error) {
      // A retryable failure is not a verdict about the package: GitHub said "try again", or
      // the local disk did. Abort the whole sync and let the job retry. No version row exists
      // yet — they are only written in the group loop below — so the abort is clean, and the
      // terminal `needs_attention` never gets spent on a network blip.
      if (isRetryableFailure(error)) throw error;
      // Nothing about this package is trustworthy — the download failed permanently or the
      // archive did not parse — so there is no id to attribute it to. Release-wide on purpose.
      recordIssue(
        issueLog,
        {
          code:
            error instanceof Error && "code" in error
              ? String((error as { code?: string }).code)
              : "asset_failed",
          detail: asset.name,
        },
        null,
      );
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
    // Read-only, so it can run before the group is judged: an inconsistent group still needs
    // to know whether its id belongs to this repository before it may report anything about
    // the versions already stored under it.
    const resolution = await resolveProduct(db, { extensionId, repoId });

    if (
      candidates.some(
        (item) =>
          item.manifest.version !== first.manifest.version ||
          item.manifest.type !== first.manifest.type,
      )
    ) {
      // The group is rejected as a whole: manifests that disagree cannot say which version,
      // or which bytes, is the truth. So this branch only *reports* — it writes no version
      // row and never demotes a published one. A rejected group's claim about an existing
      // version's new digest is not grounds for acting on that version, only for a human to
      // look; the alert exists to make the disagreement visible, not to lower a state.
      recordIssue(
        issueLog,
        { code: "manifest_mismatch", detail: extensionId },
        extensionId,
      );
      if (resolution.kind === "bound") {
        await reportVersionConflicts(db, issueLog, {
          productId: resolution.product.id,
          extensionId,
          candidates,
        });
      }
      continue;
    }

    const seenPlatforms = new Set<string>();
    const duplicatePlatform = candidates.some((item) => {
      const key = `${item.platform.os}/${item.platform.arch}`;
      if (seenPlatforms.has(key)) return true;
      seenPlatforms.add(key);
      return false;
    });

    if (resolution.kind !== "bound") {
      // Nothing is written to `products` here. An unowned id becomes a claim the developer
      // accepts by importing or claiming the repository; a product that already exists but
      // points elsewhere is only reported, because a claim on someone else's product would
      // put an unanswerable row in the queue.
      if (resolution.kind === "unclaimed") {
        if (installationId === null) {
          recordIssue(
            issueLog,
            { code: "repo_unknown", detail: extensionId },
            extensionId,
          );
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
      // Attributed: an id nobody owns says nothing about the extensions that do.
      recordIssue(
        issueLog,
        { code: claimIssueCode(resolution.kind), detail: extensionId },
        extensionId,
      );
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
      if (!sameAssetSet(existingAssets, candidates)) {
        await db
          .update(releaseVersions)
          .set({
            state: "needs_attention",
            detectionIssue: { code: "version_conflict", extensionId },
            updatedAt: new Date(),
          })
          .where(eq(releaseVersions.id, existing.id));
        if (existing.state === "published") touchedProducts.add(product.id);
        recordIssue(
          issueLog,
          { code: "version_conflict", detail: `${extensionId}@${version}` },
          extensionId,
        );
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
    // Only this extension's own issues — plus the unattributable ones — may hold its
    // version. A sibling's `digest_mismatch` belongs to the sibling (§10 Q3).
    //
    // The verdict is a snapshot taken at insert time, so the invariant is: every issue that
    // can belong to this extension is already in the log by this line. Package-level ones
    // land in the asset stage above; this group's own checks each `continue` before reaching
    // here. A `recordIssue` added after the insert would be silently ignored by the state
    // written below, with no test failure to warn anyone.
    const state =
      duplicatePlatform || issuesHolding(issueLog, extensionId).length > 0
        ? "needs_attention"
        : decision.state;

    // One transaction, because a retry must never see a version row with no assets: the
    // `existing` branch above compares the stored asset set, so a half-written row would read
    // as a digest change and demote a perfectly good version to `needs_attention` — the exact
    // terminal state this sync path exists to avoid. In-memory bookkeeping (`touchedProducts`,
    // the counters) stays outside and follows the commit.
    const written = await db.transaction(async (tx) => {
      const [versionRow] = await tx
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

      // A throw, not `return null`: returning would *commit* whatever the callback already
      // wrote — an empty transaction today, half a version tomorrow. There is nothing to skip
      // gracefully here; an insert that reports no row is a broken assumption, and the only
      // correct outcome is to roll the transaction back.
      if (!versionRow) {
        throw new Error("release version insert returned no row");
      }

      // A published product that gets a held version is exactly the re-review bucket the
      // moderator console lists; the reason is recorded for the timeline.
      if (decision.state === "pending_review" && product.status === "published") {
        await recordModerationEvent(tx, {
          releaseVersionId: versionRow.id,
          action: "re_review_required",
          fromState: null,
          toState: "pending_review",
          reason: decision.reason,
        });
      } else if (versionRow.state === "published" && decision.state === "published") {
        // Auto-publish used to leave no trace at all, which made the admin console's "recent
        // decisions" list look like every publish was a human one. Record the machine
        // decision with the same reason vocabulary the hold path uses.
        await recordModerationEvent(tx, {
          releaseVersionId: versionRow.id,
          action: "auto_published",
          fromState: null,
          toState: "published",
          reason: decision.reason,
        });
      }

      for (const item of candidates) {
        await tx
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
      }

      return { state: versionRow.state, assets: candidates.length };
    });

    versionCount += 1;
    if (written.state === "published") touchedProducts.add(product.id);
    assetCount += written.assets;
  }

  for (const productId of touchedProducts) {
    await recomputeProductLatestVersions(db, productId);
  }

  // The release-level record is the sync log, not a per-extension verdict: any issue at all
  // still marks the release `needs_attention` and the full list is still stored, so grouping
  // never costs information.
  await db
    .update(repoReleases)
    .set({
      syncState: issueLog.all.length > 0 ? "needs_attention" : "synced",
      syncError:
        issueLog.all.length > 0
          ? JSON.stringify(issueLog.all).slice(0, 2000)
          : null,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(repoReleases.id, repoRelease.id));

  return {
    repoReleaseId: repoRelease.id,
    versions: versionCount,
    assets: assetCount,
    issues: issueLog.all,
    productIds: [...syncedProducts],
  };
}
