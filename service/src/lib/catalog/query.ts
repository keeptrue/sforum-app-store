import { createHash } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Db } from "@/db/client";
import {
  accounts,
  assets,
  githubInstallations,
  githubRepos,
  oauthIssuers,
  productReadmes,
  productTranslations,
  products,
  releaseAssets,
  releaseVersions,
  type ManifestLocaleRow,
} from "@/db/schema";
import type { components } from "@/lib/api-types";
import {
  compareVersionsDesc,
  constraintMatches,
  effectiveHostVersion,
  isDevBuild,
  maxVersion,
  parseConstraint,
  type HostVersion,
  type ParsedConstraint,
} from "@/lib/catalog/compat";
import { decodeCursor, encodeCursor, type CatalogCursor } from "@/lib/catalog/cursor";
import { parseExtensionIds } from "@/lib/catalog/extension-ids";
import { releaseNotesHtml } from "@/lib/readme/notes";
import { assetUrl } from "@/lib/storage/urls";

export type ProductSummary = components["schemas"]["ProductSummary"];

/**
 * The `assets` table appears twice in the catalog query: once for the product mark and once
 * for the brand social card. `leftJoin(assets, …)` twice would replace the first join.
 */
const ogAssets = alias(assets, "og_assets");
export type ProductDetail = components["schemas"]["ProductDetail"];
export type ProductReadme = components["schemas"]["ProductReadme"];
export type ReleaseVersion = components["schemas"]["ReleaseVersion"];
export type Compatibility = components["schemas"]["Compatibility"];
export type CatalogPageBody = components["schemas"]["CatalogPage"];

export const CATALOG_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

const DEFAULT_LIMIT = 18;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const MAX_QUERY_LENGTH = 120;

export type CatalogQuery = {
  channel: "stable" | "beta" | null;
  sforum: string | null;
  sforumBuild: string | null;
  os: string | null;
  arch: string | null;
  /**
   * Architecture axis of the *list* filter. `strict` (the default) hides products that no
   * candidate release supports on this host; `all` keeps them so the client can badge them
   * instead. It never changes how `compatibility` is computed — see `buildSummary`.
   */
  platform: "strict" | "all";
  compat: "compatible" | "all";
  q: string | null;
  category: string | null;
  /** `kind` is a shelf filter (plugin / theme), never a data claim about a product. */
  kind: "plugin" | "theme" | null;
  /**
   * Batch filter for "which of my installed extensions have an update?". Sorted and
   * de-duplicated by `parseExtensionIds`; `null` means the parameter was absent (or blank),
   * which is not the same as an empty result set.
   */
  extensionIds: string[] | null;
  cursor: string | null;
  limit: number;
};

export type CatalogQueryResult =
  | { ok: true; query: CatalogQuery }
  | { ok: false; code: "invalid_query" | "invalid_cursor" };

function cleaned(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function parseCatalogQuery(searchParams: URLSearchParams): CatalogQueryResult {
  const channel = cleaned(searchParams.get("channel"));
  if (channel !== null && channel !== "stable" && channel !== "beta") {
    return { ok: false, code: "invalid_query" };
  }

  // Host identity is parsed first: it decides the default `compat` mode below.
  const sforum = cleaned(searchParams.get("sforum"));
  const sforumBuild = cleaned(searchParams.get("sforumBuild"));

  const compatParam = cleaned(searchParams.get("compat"));
  if (compatParam !== null && compatParam !== "compatible" && compatParam !== "all") {
    return { ok: false, code: "invalid_query" };
  }
  // A dev build only knows an approximate core version, so filtering on it hides packages
  // that would install fine. Default those callers to the unfiltered view; the response
  // echoes `compat` so nobody has to guess which mode ran.
  const compat: "compatible" | "all" =
    compatParam ?? (isDevBuild(sforumBuild) ? "all" : "compatible");

  const limitParam = cleaned(searchParams.get("limit"));
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    if (!/^\d+$/.test(limitParam)) return { ok: false, code: "invalid_query" };
    limit = Number(limitParam);
    if (limit < MIN_LIMIT || limit > MAX_LIMIT) return { ok: false, code: "invalid_query" };
  }

  const q = cleaned(searchParams.get("q"));
  if (q !== null && q.length > MAX_QUERY_LENGTH) return { ok: false, code: "invalid_query" };

  const kindParam = cleaned(searchParams.get("kind"));
  if (kindParam !== null && kindParam !== "plugin" && kindParam !== "theme") {
    return { ok: false, code: "invalid_query" };
  }
  const kind: "plugin" | "theme" | null = kindParam;

  // Batch update check: the plugin sends the ids it has installed. An unreadable id is a
  // caller bug, so it is a 400 rather than a silently narrower answer — a wrong "no update"
  // would look exactly like a correct one.
  const extensionIds = parseExtensionIds(searchParams.get("extensionIds"));
  if (!extensionIds.ok) return { ok: false, code: "invalid_query" };

  // Unlike `compat`, this default never depends on the host build: omitting the parameter
  // is exactly `strict`, so a client that predates it keeps today's list.
  const platformParam = cleaned(searchParams.get("platform"));
  if (platformParam !== null && platformParam !== "strict" && platformParam !== "all") {
    return { ok: false, code: "invalid_query" };
  }
  const platform: "strict" | "all" = platformParam ?? "strict";

  const cursor = cleaned(searchParams.get("cursor"));
  if (cursor !== null && decodeCursor(cursor) === null) {
    return { ok: false, code: "invalid_cursor" };
  }

  return {
    ok: true,
    query: {
      channel,
      sforum,
      sforumBuild,
      os: cleaned(searchParams.get("os")),
      arch: cleaned(searchParams.get("arch")),
      platform,
      compat,
      q,
      category: cleaned(searchParams.get("category")),
      kind,
      extensionIds: extensionIds.ids,
      cursor,
      limit,
    },
  };
}

/**
 * ETag for a public read. The body hash alone would let two different viewers share a
 * cache entry whenever the response happens to look identical (an empty catalog with
 * `limit=18` and `limit=100`, or a dev build string), and plan §7.3.4 requires every
 * query dimension - including `sforum` / `sforumBuild` - to change the validator, so the
 * caller's fingerprint is folded into the same digest.
 */
export function etagForJson(body: unknown, fingerprint?: string): string {
  const digest = createHash("sha256").update(JSON.stringify(body), "utf8");
  if (fingerprint !== undefined) digest.update("\n").update(fingerprint, "utf8");
  return digest.digest("hex");
}

/** `If-None-Match` may be a comma list and may prefix each entry with `W/`. */
export function ifNoneMatchMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header.split(",").some((part) => {
    const value = part.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
    return value === "*" || value === etag;
  });
}

// ---------------------------------------------------------------------------
// Rows loaded from PostgreSQL. All semver work happens in TypeScript: constraint
// validity is a node-semver question, so SQL cannot decide it (plan §5.7).
// ---------------------------------------------------------------------------

type ReleaseAssetRow = {
  os: string;
  arch: string;
  filename: string;
  size: number;
  sha256: string;
};

type VersionRow = {
  id: string;
  productId: string;
  version: string;
  channel: "stable" | "beta";
  state:
    | "candidate"
    | "pending_review"
    | "published"
    | "rejected"
    | "yanked"
    | "needs_attention";
  constraint: string;
  /** Parsed Masterminds constraint, or null when the manifest's value is unusable. */
  parsed: ParsedConstraint | null;
  capabilities: string[];
  manifestDescription: string | null;
  manifestUrl: string | null;
  manifestAuthorName: string | null;
  manifestAuthorUrl: string | null;
  manifestLangs: Record<string, ManifestLocaleRow>;
  notesMd: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  assets: ReleaseAssetRow[];
};

type ProductFacets = {
  id: string;
  slug: string;
  extensionId: string;
  name: string;
  kind: "plugin" | "theme";
  category: string | null;
  tags: string[];
  updatedAt: Date;
  latestStableVersionId: string | null;
  latestBetaVersionId: string | null;
  translationName: string | null;
  translationSummary: string | null;
  iconSha256: string | null;
  /** The brand social card, used as the card cover; null when the package ships none. */
  socialSha256: string | null;
  ownerDisplayName: string | null;
  ownerUsername: string | null;
  ownerAvatarUrl: string | null;
  /** The issuer base URL the owner logged in from; null when that issuer row is gone. */
  ownerIssuerBaseUrl: string | null;
  /** `github_installations.account_login`; null when the product has no bound repository. */
  githubAccountLogin: string | null;
  repoId: number | null;
  repoFullName: string | null;
  // README cache columns. `readmeRepoId` is compared with `repoId` so a row left over from
  // a previous binding is never rendered as the current repository's introduction.
  readmeRepoId: number | null;
  readmePath: string | null;
  readmeBlobSha: string | null;
  readmeHtml: string | null;
  readmeByteSize: number | null;
  readmeFetchedAt: Date | null;
};

type CatalogView = {
  channel: "stable" | "beta" | null;
  os: string | null;
  arch: string | null;
  platform: "strict" | "all";
  compat: "compatible" | "all";
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

async function loadProductFacets(
  db: Db,
  filters: {
    slug?: string;
    q?: string;
    category?: string;
    kind?: "plugin" | "theme";
    extensionIds?: string[];
  },
): Promise<ProductFacets[]> {
  const conditions: SQL[] = [
    eq(products.status, "published"),
    // Connectivity is a repo-level axis (plan Q2): no row means "never bound", and only
    // `disconnected` takes the product offline; `degraded` stays listed.
    or(isNull(githubRepos.id), ne(githubRepos.upstreamState, "disconnected")) ?? sql`true`,
    sql`exists (select 1 from "release_versions" rv where rv."product_id" = ${products.id} and rv."state" = 'published')`,
  ];

  if (filters.slug !== undefined) conditions.push(eq(products.slug, filters.slug));
  if (filters.category !== undefined) conditions.push(eq(products.category, filters.category));
  if (filters.kind !== undefined) conditions.push(eq(products.kind, filters.kind));
  // Empty array = no filter, mirroring `parseExtensionIds` turning a blank parameter into
  // `null`. `inArray` with `[]` would be a SQL `false` and answer "nothing" instead.
  if (filters.extensionIds !== undefined && filters.extensionIds.length > 0) {
    conditions.push(inArray(products.extensionId, filters.extensionIds));
  }
  if (filters.q !== undefined) {
    const pattern = `%${escapeLike(filters.q)}%`;
    conditions.push(
      or(
        ilike(products.name, pattern),
        ilike(products.extensionId, pattern),
        ilike(productTranslations.name, pattern),
        ilike(productTranslations.summary, pattern),
        ilike(accounts.displayName, pattern),
        ilike(accounts.username, pattern),
      ) ?? sql`false`,
    );
  }

  const rows = await db
    .select({
      id: products.id,
      slug: products.slug,
      extensionId: products.extensionId,
      name: products.name,
      kind: products.kind,
      category: products.category,
      tags: products.tags,
      updatedAt: products.updatedAt,
      latestStableVersionId: products.latestStableVersionId,
      latestBetaVersionId: products.latestBetaVersionId,
      translationName: productTranslations.name,
      translationSummary: productTranslations.summary,
      iconSha256: assets.sha256,
      socialSha256: ogAssets.sha256,
      ownerDisplayName: accounts.displayName,
      ownerUsername: accounts.username,
      ownerAvatarUrl: accounts.avatarUrl,
      ownerIssuerBaseUrl: oauthIssuers.baseUrl,
      githubAccountLogin: githubInstallations.accountLogin,
      repoId: products.repoId,
      repoFullName: githubRepos.fullName,
      readmeRepoId: productReadmes.repoId,
      readmePath: productReadmes.path,
      readmeBlobSha: productReadmes.blobSha,
      readmeHtml: productReadmes.html,
      readmeByteSize: productReadmes.byteSize,
      readmeFetchedAt: productReadmes.fetchedAt,
    })
    .from(products)
    .leftJoin(
      productTranslations,
      and(
        eq(productTranslations.productId, products.id),
        sql`${productTranslations.locale} = ${products.defaultLocale}`,
      ),
    )
    .leftJoin(assets, eq(assets.id, products.previewAssetId))
    // Second alias of the same table: one product can carry two images (mark + card), and
    // reusing `assets` twice would collapse the join.
    .leftJoin(ogAssets, eq(ogAssets.id, products.ogAssetId))
    .leftJoin(productReadmes, eq(productReadmes.productId, products.id))
    .leftJoin(accounts, eq(accounts.id, products.ownerAccountId))
    // The forum the owner logged in from: its base URL is what makes a profile link possible.
    // The store never guesses a forum host, and the plugin has no way to learn one.
    .leftJoin(oauthIssuers, eq(oauthIssuers.issuerKey, accounts.issuerKey))
    .leftJoin(githubRepos, eq(githubRepos.repoId, products.repoId))
    // The maintainer's GitHub side: which account the bound repository lives under. Not the
    // same claim as "the author" (an org repository belongs to the org, not the developer),
    // which is why the field is named `github` and the UI says 仓库账号.
    .leftJoin(
      githubInstallations,
      eq(githubInstallations.installationId, githubRepos.installationId),
    )
    .where(and(...conditions))
    .orderBy(desc(products.updatedAt), desc(products.id));

  return rows;
}

/** Loads every published/yanked version (with its assets) for the given products. */
async function loadVersionRows(
  db: Db,
  productIds: string[],
): Promise<Map<string, VersionRow[]>> {
  const grouped = new Map<string, VersionRow[]>();
  if (productIds.length === 0) return grouped;

  const rows = await db
    .select({
      id: releaseVersions.id,
      productId: releaseVersions.productId,
      version: releaseVersions.version,
      channel: releaseVersions.channel,
      state: releaseVersions.state,
      constraint: releaseVersions.sforumVersionConstraint,
      capabilities: releaseVersions.capabilities,
      manifestDescription: releaseVersions.manifestDescription,
      manifestUrl: releaseVersions.manifestUrl,
      manifestAuthorName: releaseVersions.manifestAuthorName,
      manifestAuthorUrl: releaseVersions.manifestAuthorUrl,
      manifestLangs: releaseVersions.manifestLangs,
      notesMd: releaseVersions.notesMd,
      publishedAt: releaseVersions.publishedAt,
      createdAt: releaseVersions.createdAt,
      assetOs: releaseAssets.os,
      assetArch: releaseAssets.arch,
      assetFilename: releaseAssets.filename,
      assetSize: releaseAssets.size,
      assetSha256: releaseAssets.sha256,
    })
    .from(releaseVersions)
    .leftJoin(releaseAssets, eq(releaseAssets.releaseVersionId, releaseVersions.id))
    .where(
      and(
        inArray(releaseVersions.productId, productIds),
        inArray(releaseVersions.state, ["published", "yanked"]),
      ),
    )
    .orderBy(asc(releaseAssets.os), asc(releaseAssets.arch));

  for (const row of rows) {
    let bucket = grouped.get(row.productId);
    if (!bucket) {
      bucket = [];
      grouped.set(row.productId, bucket);
    }
    let version = bucket.find((entry) => entry.id === row.id);
    if (!version) {
      version = {
        id: row.id,
        productId: row.productId,
        version: row.version,
        channel: row.channel,
        state: row.state,
        constraint: row.constraint,
        parsed: parseConstraint(row.constraint),
        capabilities: row.capabilities,
        manifestDescription: row.manifestDescription,
        manifestUrl: row.manifestUrl,
        manifestAuthorName: row.manifestAuthorName,
        manifestAuthorUrl: row.manifestAuthorUrl,
        manifestLangs: row.manifestLangs,
        notesMd: row.notesMd,
        publishedAt: row.publishedAt,
        createdAt: row.createdAt,
        assets: [],
      };
      bucket.push(version);
    }
    if (row.assetOs !== null && row.assetArch !== null && row.assetFilename !== null) {
      version.assets.push({
        os: row.assetOs,
        arch: row.assetArch,
        filename: row.assetFilename,
        size: row.assetSize ?? 0,
        sha256: row.assetSha256 ?? "",
      });
    }
  }

  return grouped;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function sortedAssets(row: VersionRow): ReleaseAssetRow[] {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...row.assets].sort(
    (a, b) => compare(a.os, b.os) || compare(a.arch, b.arch),
  );
}

/**
 * Every public read is built on this set: published, channel-matching, and carrying a
 * semver constraint that actually parses. A manifest with an unusable `sforumVersion`
 * keeps its row for moderation but is invisible here (plan §5.7 / §7.3.10).
 */
function publishedCandidates(
  versions: VersionRow[],
  channel: "stable" | "beta" | null,
): VersionRow[] {
  return versions.filter(
    (row) =>
      row.state === "published" &&
      row.parsed !== null &&
      (channel === null || row.channel === channel),
  );
}

function hasPlatform(row: VersionRow, os: string | null, arch: string | null): boolean {
  if (os === null && arch === null) return true;
  // `any` is a wildcard, not a literal platform: themes ship `any/any` and still run
  // everywhere, so a host asking for linux/amd64 must see them (plan §5.5: themes have no
  // backend binary).
  return row.assets.some(
    (asset) =>
      (os === null || asset.os === os || asset.os === "any") &&
      (arch === null || asset.arch === arch || asset.arch === "any"),
  );
}

function findCompatible(
  versions: VersionRow[],
  hostVersion: string,
  os: string | null,
  arch: string | null,
): VersionRow | null {
  for (const row of versions) {
    if (row.parsed === null) continue;
    if (!constraintMatches(row.parsed, hostVersion)) continue;
    if (!hasPlatform(row, os, arch)) continue;
    return row;
  }
  return null;
}

function compatibilityOf(
  versions: VersionRow[],
  host: HostVersion,
  os: string | null,
  arch: string | null,
): Compatibility {
  if (host.version === null) return { status: "unknown", estimated: false };
  const match = findCompatible(versions, host.version, os, arch);
  if (match === null) return { status: "incompatible", estimated: host.estimated };
  return { status: "compatible", estimated: host.estimated, constraint: match.constraint };
}

function platformsOf(versions: VersionRow[]): components["schemas"]["Platform"][] {
  const seen = new Map<string, { os: string; arch: string }>();
  for (const version of versions) {
    for (const asset of version.assets) {
      seen.set(`${asset.os}\u0000${asset.arch}`, { os: asset.os, arch: asset.arch });
    }
  }
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...seen.values()].sort(
    (a, b) => compare(a.os, b.os) || compare(a.arch, b.arch),
  );
}

/**
 * Latest version per channel is the semver maximum (plan Q4: never publish time). The
 * materialized `latest_*_version_id` pointers are re-validated against the visible set
 * before use and then folded into the same maximum, so a stale pointer can never win.
 */
function pickLatestVersion(
  facets: ProductFacets,
  candidates: VersionRow[],
  channel: "stable" | "beta" | null,
): string | null {
  const hints =
    channel === "stable"
      ? [facets.latestStableVersionId]
      : channel === "beta"
        ? [facets.latestBetaVersionId]
        : [facets.latestStableVersionId, facets.latestBetaVersionId];
  const hinted = candidates
    .filter((row) => hints.includes(row.id))
    .map((row) => row.version);
  return maxVersion([...hinted, ...candidates.map((row) => row.version)]);
}

function buildSummary(
  facets: ProductFacets,
  versions: VersionRow[],
  view: CatalogView,
  host: HostVersion,
): ProductSummary | null {
  const candidates = publishedCandidates(versions, view.channel);
  if (candidates.length === 0) return null;

  const latestVersion = pickLatestVersion(facets, candidates, view.channel);
  if (latestVersion === null) return null;
  // `sforumVersion` belongs to the version the card names, so it is read from that row
  // rather than from whichever candidate happened to match the host.
  const latestRow = candidates.find((row) => row.version === latestVersion) ?? null;

  // Platform presence is a separate axis from version compatibility: a host always knows
  // its GOOS/GOARCH, even when it cannot report a usable core version (sforum=unknown).
  // Otherwise a missing `sforum` would silently ignore the platform filter and hand a
  // linux host packages for other platforms.
  //
  // `platform=all` drops only this visibility rule: the operator asked to see what exists,
  // not to have it judged installable. The flag is read as "explicitly all" rather than
  // "not strict" on purpose: the failure mode of guessing wrong is a list full of packages
  // this host cannot install, so an absent or unknown value keeps today's strict filter.
  const platformAll = view.platform === "all";
  if (
    !platformAll &&
    (view.os !== null || view.arch !== null) &&
    !candidates.some((candidate) => hasPlatform(candidate, view.os, view.arch))
  ) {
    return null;
  }

  // The reported verdict uses os/arch in both platform modes: a product that only ships
  // for another architecture is incompatible on this host, and `platform=all` must not
  // relabel it as installable merely because it is now visible.
  const compatibility = compatibilityOf(candidates, host, view.os, view.arch);
  // The `compat` filter is the *version* axis. Under `platform=all` it has to judge
  // versions only, otherwise the platform verdict would hide again exactly the rows the
  // operator just asked to see and the switch would have no visible effect at all.
  const compatVerdict = platformAll
    ? compatibilityOf(candidates, host, null, null)
    : compatibility;
  if (
    host.version !== null &&
    view.compat === "compatible" &&
    compatVerdict.status !== "compatible"
  ) {
    return null;
  }

  return {
    slug: facets.slug,
    extensionId: facets.extensionId,
    name: facets.translationName ?? facets.name,
    kind: facets.kind,
    summary: facets.translationSummary ?? "",
    category: facets.category,
    tags: facets.tags,
    iconUrl: facets.iconSha256 === null ? null : assetUrl(facets.iconSha256),
    socialImageUrl:
      facets.socialSha256 === null ? null : assetUrl(facets.socialSha256),
    latestVersion,
    // The manifest's own requirement, not a verdict: the card shows what the package asks
    // of a host, and core still decides compatibility at install time.
    sforumVersion: latestRow?.constraint ?? "",
    updatedAt: facets.updatedAt.toISOString(),
    platforms: platformsOf(candidates),
    // The card names one version, so "can this host run it" has to be answered for that
    // version alone. `platforms` stays the union: it answers the different question "does
    // any release support this host", which is what makes the "latest one cannot, an older
    // one can" state visible to the client.
    latestPlatforms: platformsOf(latestRow === null ? [] : [latestRow]),
    compatibility,
    author: authorOf(facets),
  };
}

/**
 * The maintainer block, built only from rows that exist.
 *
 * Both halves are optional and independent: a product can be owned by a forum account with
 * no repository yet, or bound to a repository whose installation row was deleted. Missing
 * one half never borrows the other's value — a fabricated author is worse than a short one.
 * `null` means neither half exists, and the client draws no author strip at all.
 */
function authorOf(facets: ProductFacets): ProductSummary["author"] {
  const username = facets.ownerUsername;
  const displayName = facets.ownerDisplayName;
  const avatarUrl = facets.ownerAvatarUrl;
  const forum = username === null && displayName === null && avatarUrl === null
    ? null
    : { username, displayName, avatarUrl };

  const login = facets.githubAccountLogin;
  const github = login === null || login.length === 0
    ? null
    : { login, url: `https://github.com/${login}` };

  if (forum === null && github === null) return null;
  return {
    username: forum?.username ?? null,
    displayName: forum?.displayName ?? null,
    avatarUrl: forum?.avatarUrl ?? null,
    profileUrl: forumProfileUrl(facets.ownerIssuerBaseUrl, forum?.username ?? null),
    github,
  };
}

/**
 * The owner's forum profile page, or null.
 *
 * Built from two facts the store already holds — the issuer base URL registered for that login
 * source and the account's username — because the route belongs to the forum (`/u/<username>`,
 * `apps/web/app/pages/u/[username].vue`) and neither the plugin page nor its backend can learn
 * the forum host any other way. A missing half yields null rather than a link into nowhere.
 */
function forumProfileUrl(baseUrl: string | null, username: string | null): string | null {
  if (baseUrl === null || username === null) return null;
  const base = baseUrl.trim().replace(/\/+$/, "");
  const name = username.trim();
  if (base.length === 0 || name.length === 0) return null;
  return `${base}/u/${encodeURIComponent(name)}`;
}

/**
 * Manifest display metadata for one version. Old rows predate these columns and carry
 * nothing, so the block stays absent instead of rendering an empty section.
 */
function manifestOf(row: VersionRow): ReleaseVersion["manifest"] {
  const langs = row.manifestLangs ?? {};
  const hasLangs = Object.keys(langs).length > 0;
  const hasAny =
    row.manifestDescription !== null ||
    row.manifestUrl !== null ||
    row.manifestAuthorName !== null ||
    hasLangs;
  if (!hasAny) return undefined;
  return {
    ...(row.manifestDescription ? { description: row.manifestDescription } : {}),
    ...(row.manifestUrl ? { url: row.manifestUrl } : {}),
    ...(row.manifestAuthorName
      ? {
          author: {
            name: row.manifestAuthorName,
            ...(row.manifestAuthorUrl ? { url: row.manifestAuthorUrl } : {}),
          },
        }
      : {}),
    ...(hasLangs ? { langs } : {}),
  };
}

function releaseOf(row: VersionRow, repoFullName: string | null): ReleaseVersion {
  const assets = sortedAssets(row).map((asset) => ({
    os: asset.os,
    arch: asset.arch,
    filename: asset.filename,
    size: asset.size,
    sha256: asset.sha256,
  }));

  const release: ReleaseVersion = {
    version: row.version,
    channel: row.channel,
    publishedAt: (row.publishedAt ?? row.createdAt).toISOString(),
    sforumVersion: row.constraint,
    status: row.state === "yanked" ? "yanked" : "published",
    // `notes` stays the raw Markdown source (audit + clients that render themselves);
    // `notesHtml` is the sanitised rendering the admin page injects.
    notes: row.notesMd ?? null,
    notesHtml: releaseNotesHtml(row.notesMd, repoFullName),
    capabilities: row.capabilities ?? [],
    assets,
  };
  const manifest = manifestOf(row);
  if (manifest) release.manifest = manifest;
  // A single-platform release carries its digest inline; multi-platform ones do not,
  // because "the" digest would be ambiguous (contract `ReleaseVersion.digest`).
  if (assets.length === 1) release.digest = assets[0].sha256;
  return release;
}

function buildReleases(
  versions: VersionRow[],
  channel: "stable" | "beta" | null,
  repoFullName: string | null,
): ReleaseVersion[] {
  return versions
    .filter(
      (row) =>
        (row.state === "published" || row.state === "yanked") &&
        row.parsed !== null &&
        (channel === null || row.channel === channel),
    )
    .sort((a, b) => compareVersionsDesc(a.version, b.version))
    .map((row) => releaseOf(row, repoFullName));
}

function pageCompatibility(host: HostVersion): Compatibility {
  if (host.version === null) return { status: "unknown", estimated: false };
  return { status: "compatible", estimated: host.estimated };
}

function queryFingerprint(query: CatalogQuery): string {
  return JSON.stringify([
    query.channel,
    query.sforum,
    query.sforumBuild,
    query.os,
    query.arch,
    // Both axes belong here: `strict` and `all` return different row sets for the same URL
    // otherwise, and a shared ETag would serve one mode's body under the other's validator.
    query.platform,
    query.compat,
    query.q,
    query.category,
    query.kind,
    // Sorted defensively: `parseCatalogQuery` already sorts, but a direct caller that built
    // the query object by hand must not get two validators for one row set.
    query.extensionIds === null ? null : [...query.extensionIds].sort(),
    query.cursor,
    query.limit,
  ]);
}

function isAfter(row: { updatedAt: Date; id: string }, cursor: CatalogCursor): boolean {
  const rowTime = row.updatedAt.getTime();
  const cursorTime = cursor.updatedAt.getTime();
  if (rowTime !== cursorTime) return rowTime < cursorTime;
  return row.id < cursor.id;
}

// ---------------------------------------------------------------------------
// Public read model
// ---------------------------------------------------------------------------

export async function listCatalog(
  db: Db,
  query: CatalogQuery,
): Promise<{ body: CatalogPageBody; etag: string }> {
  const host = effectiveHostVersion(query.sforum, query.sforumBuild);
  const view: CatalogView = {
    channel: query.channel,
    os: query.os,
    arch: query.arch,
    platform: query.platform,
    compat: query.compat,
  };

  const facets = await loadProductFacets(db, {
    q: query.q ?? undefined,
    category: query.category ?? undefined,
    kind: query.kind ?? undefined,
    extensionIds: query.extensionIds ?? undefined,
  });
  const versionsByProduct = await loadVersionRows(
    db,
    facets.map((facet) => facet.id),
  );

  const rows: { summary: ProductSummary; updatedAt: Date; id: string }[] = [];
  for (const facet of facets) {
    const summary = buildSummary(
      facet,
      versionsByProduct.get(facet.id) ?? [],
      view,
      host,
    );
    if (summary !== null) {
      rows.push({ summary, updatedAt: facet.updatedAt, id: facet.id });
    }
  }

  rows.sort(
    (a, b) =>
      b.updatedAt.getTime() - a.updatedAt.getTime() ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );

  const total = rows.length;
  // parseCatalogQuery already rejected undecodable tokens; a caller that bypassed it
  // simply starts from the first page instead of failing the whole read.
  const cursor = query.cursor === null ? null : decodeCursor(query.cursor);
  const remaining = cursor === null ? rows : rows.filter((row) => isAfter(row, cursor));
  const page = remaining.slice(0, query.limit);
  const last = page[page.length - 1];
  const nextCursor =
    remaining.length > page.length && last !== undefined
      ? encodeCursor({ updatedAt: last.updatedAt, id: last.id })
      : null;

  const body: CatalogPageBody = {
    items: page.map((row) => row.summary),
    total,
    nextCursor,
    compatibility: pageCompatibility(host),
    // Echo the mode that actually ran: a caller that omitted `compat` otherwise cannot
    // tell the dev default from an explicit request. Optional, so old clients ignore it.
    compat: view.compat,
  };

  return { body, etag: etagForJson(body, queryFingerprint(query)) };
}

/**
 * The README as the public contract publishes it, or null.
 *
 * Three conditions, all of them about honesty rather than availability: a row exists, the
 * row was fetched from the product's *current* repository, and the repository is bound at
 * all. A README fetched before a rebind describes someone else's project.
 */
function toProductReadme(facet: ProductFacets): ProductReadme | null {
  if (
    facet.readmeHtml === null ||
    facet.readmePath === null ||
    facet.readmeFetchedAt === null ||
    facet.repoFullName === null ||
    facet.repoId === null ||
    facet.readmeRepoId !== facet.repoId
  ) {
    return null;
  }
  return {
    html: facet.readmeHtml,
    sourceUrl: `https://github.com/${facet.repoFullName}/blob/HEAD/${facet.readmePath}`,
    sha: facet.readmeBlobSha,
    fetchedAt: facet.readmeFetchedAt.toISOString(),
    byteSize: facet.readmeByteSize ?? undefined,
  };
}

export async function loadProductDetail(
  db: Db,
  slug: string,
  view?: { sforum?: string | null; sforumBuild?: string | null },
): Promise<ProductDetail | null> {
  const facets = await loadProductFacets(db, { slug });
  const facet = facets[0];
  if (facet === undefined) return null;

  const versions = (await loadVersionRows(db, [facet.id])).get(facet.id) ?? [];
  // No published version with a usable constraint means the product is not in the
  // catalog at all, so the detail and its releases read as absent (404, never 403).
  if (publishedCandidates(versions, null).length === 0) return null;

  const host = effectiveHostVersion(view?.sforum, view?.sforumBuild);
  const summary = buildSummary(
    facet,
    versions,
    // The detail page must not narrow on platform: it publishes every release and the
    // client picks one. `platform: "all"` here means "no architecture narrowing", which is
    // why `latestPlatforms` is still filled from the latest row.
    { channel: null, os: null, arch: null, platform: "all", compat: "all" },
    host,
  );
  if (summary === null) return null;

  return {
    ...summary,
    readme: toProductReadme(facet),
    repoUrl:
      facet.repoFullName === null ? null : `https://github.com/${facet.repoFullName}`,
    releases: buildReleases(versions, null, facet.repoFullName),
  };
}

export async function listProductReleases(
  db: Db,
  slug: string,
  opts?: { channel?: "stable" | "beta" | null },
): Promise<ReleaseVersion[] | null> {
  const facets = await loadProductFacets(db, { slug });
  const facet = facets[0];
  if (facet === undefined) return null;

  const versions = (await loadVersionRows(db, [facet.id])).get(facet.id) ?? [];
  if (publishedCandidates(versions, null).length === 0) return null;

  return buildReleases(versions, opts?.channel ?? null, facet.repoFullName);
}

export async function getProductRelease(
  db: Db,
  slug: string,
  version: string,
): Promise<ReleaseVersion | null> {
  const facets = await loadProductFacets(db, { slug });
  const facet = facets[0];
  if (facet === undefined) return null;

  const versions = (await loadVersionRows(db, [facet.id])).get(facet.id) ?? [];
  if (publishedCandidates(versions, null).length === 0) return null;

  // Exact manifest version, no `v`-prefix tolerance (plan §7.3.16).
  const match = buildReleases(versions, null, facet.repoFullName).find(
    (release) => release.version === version,
  );
  return match ?? null;
}

/**
 * The product page's link-preview image, read separately from the catalog DTO.
 *
 * The Open Graph card is presentation for the store's own HTML, not part of `/api/v1`: the
 * public contract carries one icon (`iconUrl`) and adding a second image field would make
 * every plugin panel DTO grow for a slot only Next's metadata consumes. The extra indexed
 * read costs less than that contract change.
 *
 * Only published products resolve, so a 404 page cannot emit a real product's card.
 */
export async function loadProductSocialImage(
  db: Db,
  slug: string,
): Promise<{
  name: string;
  summary: string;
  /** Null when the repository ships no `brand/social-preview.png`. */
  sha256: string | null;
  width: number | null;
  height: number | null;
} | null> {
  const [row] = await db
    .select({
      name: products.name,
      translationName: productTranslations.name,
      summary: productTranslations.summary,
      sha256: assets.sha256,
      width: assets.width,
      height: assets.height,
    })
    .from(products)
    // Left join: the product still has a title and a description without a card, and the
    // page must not fall back to the site name just because nobody drew one.
    .leftJoin(assets, eq(assets.id, products.ogAssetId))
    .leftJoin(
      productTranslations,
      and(
        eq(productTranslations.productId, products.id),
        sql`${productTranslations.locale} = ${products.defaultLocale}`,
      ),
    )
    .where(and(eq(products.slug, slug), eq(products.status, "published")))
    .limit(1);
  if (!row) return null;
  return {
    name: row.translationName ?? row.name,
    summary: row.summary ?? "",
    sha256: row.sha256 ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
  };
}
