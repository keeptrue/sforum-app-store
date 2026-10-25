import { eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import {
  githubRepos,
  products,
  releaseAssets,
  releaseVersions,
} from "@/db/schema";
import type { DownloadClaims } from "./token";

export type DownloadTarget = {
  assetId: string;
  filename: string;
  size: number;
  sha256: string;
  repoFullName: string;
  /**
   * A private repository's signed object URL names the repository, the tag and the file, so
   * the redirect mode refuses those and keeps proxying them.
   */
  repoPrivate: boolean;
  installationId: number;
  upstreamAssetId: number;
};

export type ResolveResult =
  | { ok: true; target: DownloadTarget }
  | { ok: false; status: number; code: string };

const GONE = 410;

/**
 * Re-check the token's claims against the database before any byte leaves the store.
 *
 * The order is contract (plan §7.3 items 21–22): asset present, digest unchanged, release
 * still published, product still published, upstream reachable. A yank or a disconnect is
 * therefore visible on the very next request, which is what keeps a 30-minute reusable link
 * safe without a per-token revocation table.
 *
 * Deliberately absent: any comparison against the product's *current* latest version.
 * Publishing v2 must not invalidate a v1 link — the install intent in flight would turn into
 * a `download_failed` that core can never re-sign.
 */
export async function resolveDownloadTarget(
  db: Db,
  claims: DownloadClaims,
): Promise<ResolveResult> {
  const [asset] = await db
    .select({
      id: releaseAssets.id,
      filename: releaseAssets.filename,
      size: releaseAssets.size,
      sha256: releaseAssets.sha256,
      releaseVersionId: releaseAssets.releaseVersionId,
      upstreamAssetId: releaseAssets.upstreamAssetId,
    })
    .from(releaseAssets)
    .where(eq(releaseAssets.id, claims.a))
    .limit(1);

  if (!asset) return gone("asset_missing");
  // "Digest matches" means token↔DB only (Q5). The bytes are never re-hashed on the way out:
  // the upstream ZIP is streamed untouched, so this check guards against a swapped asset row,
  // not against a corrupted transfer.
  if (asset.sha256 !== claims.s) return gone("digest_mismatch");

  const [version] = await db
    .select({
      state: releaseVersions.state,
      productId: releaseVersions.productId,
    })
    .from(releaseVersions)
    .where(eq(releaseVersions.id, asset.releaseVersionId))
    .limit(1);

  if (!version || version.state !== "published") return gone("release_unpublished");

  const [product] = await db
    .select({ status: products.status, repoId: products.repoId })
    .from(products)
    .where(eq(products.id, version.productId))
    .limit(1);

  if (!product || product.status !== "published") return gone("product_unpublished");

  const repo =
    product.repoId === null ? null : await findRepo(db, product.repoId);
  if (!repo) return gone("upstream_disconnected");
  if (repo.upstreamState === "disconnected") return gone("upstream_disconnected");
  if (repo.upstreamState === "degraded") {
    return { ok: false, status: 503, code: "upstream_degraded" };
  }

  return {
    ok: true,
    target: {
      assetId: asset.id,
      filename: asset.filename,
      size: asset.size,
      sha256: asset.sha256,
      repoFullName: repo.fullName,
      repoPrivate: repo.private,
      installationId: repo.installationId,
      upstreamAssetId: asset.upstreamAssetId,
    },
  };
}

function gone(code: string): ResolveResult {
  return { ok: false, status: GONE, code };
}

async function findRepo(db: Db, repoId: number) {
  const [row] = await db
    .select({
      fullName: githubRepos.fullName,
      private: githubRepos.private,
      installationId: githubRepos.installationId,
      upstreamState: githubRepos.upstreamState,
    })
    .from(githubRepos)
    .where(eq(githubRepos.repoId, repoId))
    .limit(1);

  return row ?? null;
}
