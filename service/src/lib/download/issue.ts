import { and, eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import {
  githubRepos,
  products,
  releaseAssets,
  releaseVersions,
} from "@/db/schema";
import { signDownloadToken } from "./token";

/** `release_assets.os` / `.arch` are open text; this is the only shape guard we impose. */
const MAX_PLATFORM_LENGTH = 32;

export type IssueInput = {
  product: string;
  version?: string | null;
  os: string;
  arch: string;
};

export type IssueDeps = {
  secret: string;
  publicUrl: string;
  ttlSeconds: number;
  now?: number;
};

export type IssueResult =
  | {
      ok: true;
      body: { url: string; sha256: string; size: number; expiresAt: string };
      /**
       * What was actually issued, for the audit trail. The caller must not have to re-resolve
       * the product to record "which version this forum downloaded": the resolver already knows,
       * and a second lookup could disagree with the one that signed the token.
       */
      productId: string;
      versionId: string;
      version: string;
    }
  | { ok: false; status: number; code: string };

/**
 * Mint a signed download URL for one platform asset.
 *
 * Shared by `POST /api/v1/download-urls` (the plugin) and the browser 302, so both entry
 * points can never drift apart. Issuing is anonymous on purpose: "published = anyone may
 * install" is the product model, and the signature — not a session — is what the download
 * proxy trusts (plan §5.6).
 */
export async function issueDownloadUrl(
  db: Db,
  input: IssueInput,
  deps: IssueDeps,
): Promise<IssueResult> {
  const productSlug = typeof input.product === "string" ? input.product.trim() : "";
  const os = normalizePlatform(input.os);
  const arch = normalizePlatform(input.arch);

  if (!productSlug) return fail(400, "invalid_body");
  if (!os || !arch) return fail(400, "invalid_body");

  const product = await findProduct(db, productSlug);
  if (!product) return fail(404, "product_not_found");
  // Upstream connectivity is expressed separately from lifecycle (Q2): a disconnected repo
  // can not serve bytes, so it is not issuable. A missing repo row is *not* disconnected.
  if (product.upstreamState === "disconnected") {
    return fail(404, "product_not_found");
  }
  // `degraded` deliberately still issues: the catalog stays visible and the download proxy
  // answers 503, which is the same surface the plugin already handles.

  // Present-but-empty is a lookup, not "omitted": only an absent version means "latest".
  const requested =
    typeof input.version === "string" ? input.version.trim() : null;
  const version =
    requested === null
      ? await findLatestStableVersion(
          db,
          product.id,
          product.latestStableVersionId,
        )
      : await findPublishedVersion(db, product.id, requested);
  if (!version) {
    return fail(404, requested === null ? "no_stable_release" : "release_not_found");
  }

  const asset = await findAsset(db, version.id, os, arch);
  if (!asset) return fail(404, "asset_not_found");

  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const exp = now + Math.floor(deps.ttlSeconds);
  const token = signDownloadToken(
    { a: asset.id, s: asset.sha256, e: exp },
    deps.secret,
  );
  const base = deps.publicUrl.replace(/\/+$/, "");

  return {
    ok: true,
    body: {
      url: `${base}/api/v1/download/${token}`,
      sha256: asset.sha256,
      size: asset.size,
      expiresAt: new Date(exp * 1000).toISOString(),
    },
    productId: product.id,
    versionId: version.id,
    version: version.version,
  };
}

function fail(status: number, code: string): IssueResult {
  return { ok: false, status, code };
}

function normalizePlatform(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PLATFORM_LENGTH) return null;
  return trimmed;
}

type ProductRow = {
  id: string;
  latestStableVersionId: string | null;
  upstreamState: "connected" | "degraded" | "disconnected" | null;
};

async function findProduct(db: Db, slug: string): Promise<ProductRow | null> {
  const [row] = await db
    .select({
      id: products.id,
      latestStableVersionId: products.latestStableVersionId,
      upstreamState: githubRepos.upstreamState,
    })
    .from(products)
    .leftJoin(githubRepos, eq(githubRepos.repoId, products.repoId))
    .where(and(eq(products.slug, slug), eq(products.status, "published")))
    .limit(1);

  return row ?? null;
}

async function findPublishedVersion(
  db: Db,
  productId: string,
  version: string,
): Promise<{ id: string; version: string } | null> {
  const [row] = await db
    .select({ id: releaseVersions.id, version: releaseVersions.version })
    .from(releaseVersions)
    .where(
      and(
        eq(releaseVersions.productId, productId),
        eq(releaseVersions.version, version),
        eq(releaseVersions.state, "published"),
      ),
    )
    .limit(1);

  return row ?? null;
}

async function findLatestStableVersion(
  db: Db,
  productId: string,
  latestStableVersionId: string | null,
): Promise<{ id: string; version: string } | null> {
  // The pointer is materialised, so it can go stale (a yank clears it lazily). Re-read the
  // row instead of trusting the id: only a still-published stable row is issuable.
  if (!latestStableVersionId) return null;

  const [row] = await db
    .select({ id: releaseVersions.id, version: releaseVersions.version })
    .from(releaseVersions)
    .where(
      and(
        eq(releaseVersions.id, latestStableVersionId),
        eq(releaseVersions.productId, productId),
        eq(releaseVersions.state, "published"),
        eq(releaseVersions.channel, "stable"),
      ),
    )
    .limit(1);

  return row ?? null;
}

async function findAsset(
  db: Db,
  releaseVersionId: string,
  os: string,
  arch: string,
): Promise<{ id: string; sha256: string; size: number } | null> {
  const [row] = await db
    .select({
      id: releaseAssets.id,
      sha256: releaseAssets.sha256,
      size: releaseAssets.size,
    })
    .from(releaseAssets)
    .where(
      and(
        eq(releaseAssets.releaseVersionId, releaseVersionId),
        eq(releaseAssets.os, os),
        eq(releaseAssets.arch, arch),
      ),
    )
    .limit(1);

  return row ?? null;
}
