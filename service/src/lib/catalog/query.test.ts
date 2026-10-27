import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { GET as catalogGET } from "@/app/api/v1/catalog/route";
import { GET as productGET } from "@/app/api/v1/products/[slug]/route";
import { GET as productReleasesGET } from "@/app/api/v1/products/[slug]/releases/route";
import { GET as productReleaseGET } from "@/app/api/v1/products/[slug]/releases/[version]/route";
import { closeDb, getDb, getPool, type Db } from "@/db/client";
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
  repoReleases,
} from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import { maxVersion } from "@/lib/catalog/compat";
import { encodeCursor } from "@/lib/catalog/cursor";
import { MAX_EXTENSION_IDS, parseExtensionIds } from "@/lib/catalog/extension-ids";
import {
  CATALOG_CACHE_CONTROL,
  etagForJson,
  getProductRelease,
  ifNoneMatchMatches,
  listCatalog,
  listProductReleases,
  loadProductDetail,
  parseCatalogQuery,
  type CatalogPageBody,
  type CatalogQuery,
} from "@/lib/catalog/query";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

const ADA = "11111111-1111-4111-8111-111111111111";
const GRACE = "22222222-2222-4222-8222-222222222222";
const FALLBACK_REPO_ID = 999;
const FALLBACK_ASSET_LABEL = "png";

let db: Db;
let pool: ReturnType<typeof getPool>;

function sha(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function at(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

type SeedAsset = { sha: string; width?: number; height?: number };

type SeedVersion = {
  version: string;
  channel: "stable" | "beta";
  state?: "published" | "yanked" | "needs_attention" | "candidate";
  constraint: string;
  publishedAt?: Date | null;
  notes?: string | null;
  capabilities?: string[];
  assets: { os: string; arch: string; sha: string }[];
};

type SeedReadme = {
  /** Defaults to the product's own repository; a different value simulates a stale row. */
  repoId?: number;
  path?: string;
  sha: string;
  html: string;
  fetchedAt: Date;
  byteSize?: number;
};

type SeedProduct = {
  slug: string;
  extensionId: string;
  name: string;
  kind: "plugin" | "theme";
  status: "published" | "draft" | "pending_review" | "rejected" | "delisted";
  repoId: number | null;
  repoFullName?: string;
  upstreamState?: "connected" | "degraded" | "disconnected";
  category?: string | null;
  tags?: string[];
  updatedAt: Date;
  owner?: "ada" | "grace" | null;
  icon?: SeedAsset | null;
  /** `brand/social-preview.png`: the catalog cover and the product page's link preview. */
  card?: SeedAsset | null;
  readme?: SeedReadme;
  translation?: { name?: string; summary?: string };
  versions: SeedVersion[];
};

const FIXTURES: SeedProduct[] = [
  {
    slug: "markdown",
    extensionId: "sforum.markdown",
    name: "Markdown",
    kind: "plugin",
    status: "published",
    repoId: 101,
    repoFullName: "acme/markdown",
    upstreamState: "connected",
    category: "content",
    tags: ["editor", "markdown"],
    updatedAt: at("2026-10-01"),
    owner: "ada",
    icon: { sha: sha("icon-markdown") },
    card: { sha: sha("card-markdown"), width: 1280, height: 640 },
    translation: {
      name: "Markdown 增强",
      summary: "更强的编辑体验",
    },
    // The rendered README is what the detail publishes instead of a free-text description.
    readme: {
      path: "README.md",
      sha: sha("readme-markdown"),
      html: "<h1>Markdown</h1>\n<p>支持 GFM。</p>",
      fetchedAt: at("2026-10-01"),
      byteSize: 24,
    },
    versions: [
      {
        version: "1.0.0",
        channel: "stable",
        state: "yanked",
        constraint: ">=1.0.0",
        publishedAt: at("2026-08-01"),
        // Markdown source with the shapes a GitHub release body actually uses: a section
        // heading, a list and a fenced block. `notesHtml` has to come out of the same
        // renderer/allow-list as the README, with headings demoted under the release head.
        notes: ["## 变更", "", "- 支持 GFM 表格", "", "```bash", "sforum extension validate .", "```"].join("\n"),
        assets: [{ os: "linux", arch: "amd64", sha: sha("md-1000") }],
      },
      {
        version: "1.5.0",
        channel: "stable",
        state: "published",
        constraint: ">=1.2.0, <2.0.0",
        publishedAt: at("2026-09-01"),
        assets: [{ os: "linux", arch: "amd64", sha: sha("md-1500") }],
        capabilities: ["host.api", "settings.own"],
      },
      {
        version: "2.0.0-beta.1",
        channel: "beta",
        state: "published",
        constraint: ">=2.0.0-0 <3.0.0",
        publishedAt: at("2026-09-10"),
        assets: [
          { os: "linux", arch: "amd64", sha: sha("md-2000-linux") },
          { os: "darwin", arch: "arm64", sha: sha("md-2000-darwin") },
        ],
      },
    ],
  },
  {
    slug: "paper",
    extensionId: "sforum.theme-paper",
    name: "Paper",
    kind: "theme",
    status: "published",
    repoId: 200,
    repoFullName: "acme/paper",
    upstreamState: "degraded",
    category: "appearance",
    tags: ["theme"],
    updatedAt: at("2026-09-30"),
    owner: "grace",
    translation: { name: "纸张主题", summary: "轻量纸张主题" },
    versions: [
      {
        version: "2.0.0",
        channel: "stable",
        state: "published",
        constraint: ">=1.0.0",
        publishedAt: at("2026-09-02"),
        assets: [{ os: "any", arch: "any", sha: sha("paper-2000") }],
      },
      {
        version: "3.0.0",
        channel: "stable",
        state: "needs_attention",
        constraint: ">=1.0.0",
        publishedAt: at("2026-09-25"),
        assets: [{ os: "any", arch: "any", sha: sha("paper-3000") }],
      },
    ],
  },
  {
    slug: "mixed",
    extensionId: "sforum.mixed",
    name: "Mixed",
    kind: "plugin",
    status: "published",
    repoId: 800,
    repoFullName: "acme/mixed",
    upstreamState: "connected",
    category: "ops",
    updatedAt: at("2026-09-29"),
    versions: [
      {
        version: "1.0.0",
        channel: "stable",
        state: "published",
        constraint: ">=3.0.0",
        publishedAt: at("2026-08-15"),
        assets: [{ os: "linux", arch: "amd64", sha: sha("mixed-1000") }],
      },
      {
        version: "3.0.0",
        channel: "stable",
        state: "published",
        constraint: "not a range",
        publishedAt: at("2026-09-20"),
        assets: [{ os: "linux", arch: "amd64", sha: sha("mixed-3000") }],
      },
    ],
  },
  {
    slug: "mac-only",
    extensionId: "sforum.mac-only",
    name: "Mac Only",
    kind: "plugin",
    status: "published",
    repoId: 109,
    repoFullName: "acme/mac-only",
    upstreamState: "connected",
    updatedAt: at("2026-09-28"),
    versions: [
      {
        version: "1.0.0",
        channel: "stable",
        state: "published",
        constraint: ">=1.0.0",
        publishedAt: null,
        assets: [{ os: "darwin", arch: "arm64", sha: sha("mac-1000") }],
      },
    ],
  },
  {
    slug: "percent",
    extensionId: "sforum.percent",
    name: "100% Off",
    kind: "plugin",
    status: "published",
    repoId: null,
    updatedAt: at("2026-09-27"),
    versions: [
      {
        version: "1.0.0",
        channel: "stable",
        state: "published",
        constraint: ">=1.0.0",
        publishedAt: at("2026-09-03"),
        assets: [{ os: "any", arch: "any", sha: sha("percent-1000") }],
      },
    ],
  },
  {
    // The product that started this round: it declares a prerelease bound
    // (`>=3.0.12-alpha.7`) that only a tag-derived host version satisfies. It stays out of the
    // `sforum=1.5.0` lists and appears as soon as the host is new enough.
    slug: "oauth2-provider",
    extensionId: "sforum.oauth2-provider",
    name: "OAuth2 Provider",
    kind: "plugin",
    status: "published",
    repoId: 110,
    repoFullName: "acme/oauth2-provider",
    updatedAt: at("2026-09-26"),
    versions: [
      {
        version: "3.0.16",
        channel: "stable",
        state: "published",
        constraint: ">=3.0.12-alpha.7",
        publishedAt: at("2026-09-20"),
        assets: [{ os: "linux", arch: "amd64", sha: sha("oauth2-3016") }],
      },
    ],
  },
  {
    // Declares a release line no test host reaches, so an explicit `compatible` run has
    // something to drop that is "too new" rather than "too old".
    slug: "future",
    extensionId: "sforum.future",
    name: "Future Only",
    kind: "plugin",
    status: "published",
    repoId: 120,
    repoFullName: "acme/future",
    updatedAt: at("2026-09-25"),
    versions: [
      {
        version: "1.0.0",
        channel: "stable",
        state: "published",
        constraint: ">=4.0.0",
        publishedAt: at("2026-09-19"),
        assets: [{ os: "linux", arch: "amd64", sha: sha("future-1000") }],
      },
    ],
  },
  {
    slug: "legacy",
    extensionId: "sforum.legacy",
    name: "Legacy",
    kind: "plugin",
    status: "published",
    repoId: 300,
    repoFullName: "acme/legacy",
    upstreamState: "disconnected",
    updatedAt: at("2026-10-02"),
    versions: [
      {
        version: "1.0.0",
        channel: "stable",
        state: "published",
        constraint: ">=1.0.0",
        publishedAt: at("2026-07-01"),
        assets: [{ os: "linux", arch: "amd64", sha: sha("legacy-1000") }],
      },
    ],
  },
  {
    slug: "draft",
    extensionId: "sforum.draft",
    name: "Draft",
    kind: "plugin",
    status: "draft",
    repoId: 400,
    repoFullName: "acme/draft",
    updatedAt: at("2026-10-03"),
    versions: [
      {
        version: "0.1.0",
        channel: "stable",
        state: "published",
        constraint: ">=1.0.0",
        assets: [{ os: "linux", arch: "amd64", sha: sha("draft-010") }],
      },
    ],
  },
  {
    slug: "pending",
    extensionId: "sforum.pending",
    name: "Pending",
    kind: "plugin",
    status: "pending_review",
    repoId: 500,
    repoFullName: "acme/pending",
    updatedAt: at("2026-10-04"),
    versions: [
      {
        version: "0.1.0",
        channel: "stable",
        state: "published",
        constraint: ">=1.0.0",
        assets: [{ os: "linux", arch: "amd64", sha: sha("pending-010") }],
      },
    ],
  },
  {
    slug: "empty",
    extensionId: "sforum.empty",
    name: "Empty",
    kind: "plugin",
    status: "published",
    repoId: 600,
    repoFullName: "acme/empty",
    updatedAt: at("2026-10-05"),
    versions: [],
  },
  {
    slug: "broken",
    extensionId: "sforum.broken",
    name: "Broken",
    kind: "plugin",
    status: "published",
    repoId: 700,
    repoFullName: "acme/broken",
    updatedAt: at("2026-10-06"),
    versions: [
      {
        version: "9.0.0",
        channel: "stable",
        state: "published",
        constraint: "not a range",
        assets: [{ os: "linux", arch: "amd64", sha: sha("broken-900") }],
      },
    ],
  },
  {
    slug: "yanked-only",
    extensionId: "sforum.yanked-only",
    name: "Yanked Only",
    kind: "plugin",
    status: "published",
    repoId: 1000,
    repoFullName: "acme/yanked-only",
    updatedAt: at("2026-10-07"),
    versions: [
      {
        version: "1.0.0",
        channel: "stable",
        state: "yanked",
        constraint: ">=1.0.0",
        assets: [{ os: "linux", arch: "amd64", sha: sha("yanked-1000") }],
      },
    ],
  },
  {
    // The state `latestPlatforms` exists for: the newest release dropped a platform an older
    // one still ships. `platforms` (the union) says "a linux host can install something";
    // `latestPlatforms` says "the version the card names is darwin-only". Without both a
    // client cannot tell this apart from "nothing here runs on linux".
    slug: "arch-shift",
    extensionId: "sforum.arch-shift",
    name: "Arch Shift",
    kind: "plugin",
    status: "published",
    repoId: 130,
    repoFullName: "acme/arch-shift",
    upstreamState: "connected",
    updatedAt: at("2026-09-20"),
    versions: [
      {
        version: "1.0.0",
        channel: "stable",
        state: "published",
        constraint: ">=1.0.0",
        publishedAt: at("2026-08-20"),
        assets: [{ os: "linux", arch: "amd64", sha: sha("arch-shift-1000") }],
      },
      {
        version: "2.0.0",
        channel: "stable",
        state: "published",
        constraint: ">=1.0.0",
        publishedAt: at("2026-09-20"),
        assets: [{ os: "darwin", arch: "arm64", sha: sha("arch-shift-2000") }],
      },
    ],
  },
];

const VISIBLE_SLUGS = [
  "markdown",
  "paper",
  "mixed",
  "mac-only",
  "percent",
  "oauth2-provider",
  "future",
  "arch-shift",
];

async function seed(): Promise<void> {
  // The GitHub side of `Author`: bound repositories live under this installation account.
  await db.insert(githubInstallations).values({ installationId: 1, accountLogin: "acme" });

  // The forum side's profile link comes from the issuer row this account logged in through.
  await db.insert(oauthIssuers).values({
    issuerKey: "forum-a",
    displayName: "Forum A",
    baseUrl: "https://forum.test/",
    clientId: "client-1",
    clientSecretCiphertext: "v1.ciphertext",
    clientSecretKid: "kid-1",
  });

  await db.insert(accounts).values([
    {
      id: ADA,
      issuerKey: "forum-a",
      sub: "ada",
      username: "ada",
      displayName: "Ada Lovelace",
    },
    {
      id: GRACE,
      issuerKey: "forum-a",
      sub: "grace",
      username: "grace",
      displayName: "Grace Hopper",
    },
  ]);

  const assetLabels = new Map<string, SeedAsset>();
  for (const product of FIXTURES) {
    if (product.icon) assetLabels.set(product.icon.sha, product.icon);
    if (product.card) assetLabels.set(product.card.sha, product.card);
  }
  const assetRows = [...assetLabels.values()].map((asset) => ({
    sha256: asset.sha,
    mime: "image/png",
    width: asset.width ?? 512,
    height: asset.height ?? 512,
    bytes: 2048,
    storageKey: `${asset.sha.slice(0, 2)}/${asset.sha.slice(2, 4)}/${asset.sha}`,
  }));
  const insertedAssets = await db
    .insert(assets)
    .values(assetRows)
    .returning({ id: assets.id, sha256: assets.sha256 });
  const assetIds = new Map(insertedAssets.map((row) => [row.sha256, row.id]));

  const insertedProducts = await db
    .insert(products)
    .values(
      FIXTURES.map((product) => ({
        extensionId: product.extensionId,
        name: product.name,
        kind: product.kind,
        slug: product.slug,
        ownerAccountId:
          product.owner === "ada" ? ADA : product.owner === "grace" ? GRACE : null,
        repoId: product.repoId,
        status: product.status,
        category: product.category ?? null,
        tags: product.tags ?? [],
        previewAssetId: product.icon ? (assetIds.get(product.icon.sha) ?? null) : null,
        ogAssetId: product.card ? (assetIds.get(product.card.sha) ?? null) : null,
        updatedAt: product.updatedAt,
      })),
    )
    .returning({ id: products.id, slug: products.slug });
  const productIds = new Map(insertedProducts.map((row) => [row.slug, row.id]));

  const translations = FIXTURES.filter((product) => product.translation).map(
    (product) => ({
      productId: productIds.get(product.slug) as string,
      locale: "zh-CN",
      name: product.translation?.name ?? "",
      summary: product.translation?.summary ?? "",
    }),
  );
  if (translations.length > 0) await db.insert(productTranslations).values(translations);

  const readmes = FIXTURES.filter((product) => product.readme).map((product) => ({
    productId: productIds.get(product.slug) as string,
    repoId: product.readme?.repoId ?? (product.repoId as number),
    ref: "HEAD",
    path: product.readme?.path ?? "README.md",
    blobSha: product.readme?.sha as string,
    markdown: "# seeded",
    html: product.readme?.html as string,
    byteSize: product.readme?.byteSize ?? 16,
    fetchedAt: product.readme?.fetchedAt as Date,
  }));
  if (readmes.length > 0) await db.insert(productReadmes).values(readmes);

  const repos = FIXTURES.filter((product) => product.repoId !== null).map((product) => ({
    repoId: product.repoId as number,
    installationId: 1,
    fullName: product.repoFullName as string,
    upstreamState: product.upstreamState ?? "connected",
  }));
  await db.insert(githubRepos).values(repos);

  let githubReleaseId = 1;
  const releaseRows: { productId: string; repoId: number; tag: string }[] = [];
  for (const product of FIXTURES) {
    for (const version of product.versions) {
      releaseRows.push({
        productId: productIds.get(product.slug) as string,
        repoId: product.repoId ?? FALLBACK_REPO_ID,
        tag: `v${version.version}`,
      });
    }
  }
  const insertedReleases =
    releaseRows.length === 0
      ? []
      : await db
          .insert(repoReleases)
          .values(
            releaseRows.map((row) => ({
              repoId: row.repoId,
              githubReleaseId: githubReleaseId++,
              tag: row.tag,
            })),
          )
          .returning({ id: repoReleases.id, repoId: repoReleases.repoId, tag: repoReleases.tag });
  const releaseIds = new Map(
    insertedReleases.map((row) => [`${row.repoId}:${row.tag}`, row.id]),
  );

  const versionValues = FIXTURES.flatMap((product) =>
    product.versions.map((version) => ({
      productId: productIds.get(product.slug) as string,
      repoReleaseId: releaseIds.get(
        `${product.repoId ?? FALLBACK_REPO_ID}:v${version.version}`,
      ) as string,
      version: version.version,
      channel: version.channel,
      state: version.state ?? "published",
      sforumVersionConstraint: version.constraint,
      capabilities: version.capabilities ?? [],
      notesMd: version.notes ?? null,
      publishedAt: version.publishedAt ?? null,
    })),
  );
  const insertedVersions =
    versionValues.length === 0
      ? []
      : await db
          .insert(releaseVersions)
          .values(versionValues)
          .returning({
            id: releaseVersions.id,
            productId: releaseVersions.productId,
            version: releaseVersions.version,
          });
  const versionIds = new Map(
    insertedVersions.map((row) => [`${row.productId}:${row.version}`, row.id]),
  );

  let upstreamAssetId = 1;
  const assetValues = FIXTURES.flatMap((product) =>
    product.versions.flatMap((version) =>
      version.assets.map((asset) => ({
        releaseVersionId: versionIds.get(
          `${productIds.get(product.slug) as string}:${version.version}`,
        ) as string,
        os: asset.os,
        arch: asset.arch,
        filename: `${product.slug}-${version.version}-${asset.os}-${asset.arch}.zip`,
        size: 4096,
        sha256: asset.sha,
        upstreamAssetId: upstreamAssetId++,
        detectionSource: "manifest" as const,
      })),
    ),
  );
  if (assetValues.length > 0) await db.insert(releaseAssets).values(assetValues);

  // Mirror `recomputeProductLatestVersions`: semver maximum per channel, state=published.
  for (const product of FIXTURES) {
    const productId = productIds.get(product.slug) as string;
    const published = product.versions.filter(
      (version) => (version.state ?? "published") === "published",
    );
    const pick = (channel: "stable" | "beta") => {
      const best = maxVersion(
        published.filter((version) => version.channel === channel).map((v) => v.version),
      );
      if (best === null) return null;
      return versionIds.get(`${productId}:${best}`) ?? null;
    };
    await db
      .update(products)
      .set({
        latestStableVersionId: pick("stable"),
        latestBetaVersionId: pick("beta"),
      })
      .where(eq(products.id, productId));
  }
}

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  db = getDb();
  pool = getPool();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
});

beforeEach(async () => {
  await pool.query(TRUNCATE_ALL);
  await seed();
});

afterAll(async () => {
  await closeDb();
});

function query(overrides: Partial<CatalogQuery> = {}): CatalogQuery {
  return {
    channel: null,
    sforum: null,
    sforumBuild: null,
    os: null,
    arch: null,
    // Mirrors `parseCatalogQuery`: an absent parameter is `strict`, so a helper that forgot
    // this field would silently test the widened list instead of the default one.
    platform: "strict",
    compat: "compatible",
    q: null,
    category: null,
    kind: null,
    extensionIds: null,
    cursor: null,
    limit: 18,
    ...overrides,
  };
}

type RouteContext<T> = { params: Promise<T> };

function catalogUrl(params: Record<string, string> = {}): string {
  const search = new URLSearchParams(params).toString();
  return search.length === 0
    ? "http://localhost/api/v1/catalog"
    : `http://localhost/api/v1/catalog?${search}`;
}

async function catalog(params: Partial<CatalogQuery> = {}) {
  return listCatalog(db, query(params));
}

async function slugs(params: Partial<CatalogQuery> = {}): Promise<string[]> {
  const { body } = await catalog(params);
  return body.items.map((item) => item.slug);
}

/**
 * Route-level read: goes through `parseCatalogQuery`, so the compat default that depends on
 * the host build is the one the service actually applies.
 */
async function catalogPage(params: Record<string, string> = {}): Promise<CatalogPageBody> {
  const response = await catalogGET(new Request(catalogUrl(params)));
  expect(response.status).toBe(200);
  return (await response.json()) as CatalogPageBody;
}

describe("parseCatalogQuery", () => {
  test("applies defaults", () => {
    expect(parseCatalogQuery(new URLSearchParams())).toEqual({
      ok: true,
      query: query(),
    });
  });

  test("defaults compat by host build", () => {
    const compatOf = (params: Record<string, string>) => {
      const parsed = parseCatalogQuery(new URLSearchParams(params));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return null;
      return parsed.query.compat;
    };

    expect(compatOf({})).toBe("compatible");
    expect(compatOf({ sforum: "1.5.0" })).toBe("compatible");
    // A dev build only reports an approximate core version, so it is not filtered by default.
    expect(compatOf({ sforum: "1.5.0", sforumBuild: "dev-abc12" })).toBe("all");
    // An explicit value always wins, including `compatible` on a dev build.
    expect(compatOf({ sforumBuild: "dev-abc12", compat: "compatible" })).toBe("compatible");
    expect(compatOf({ compat: "all" })).toBe("all");
  });

  test("reads every dimension", () => {
    const parsed = parseCatalogQuery(
      new URLSearchParams({
        channel: "beta",
        sforum: "1.5.0",
        sforumBuild: "dev-abc12",
        os: "linux",
        arch: "amd64",
        platform: "all",
        compat: "all",
        q: "mark",
        category: "content",
        kind: "plugin",
        extensionIds: "sforum.theme-paper,sforum.markdown",
        limit: "5",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.query).toEqual({
      channel: "beta",
      sforum: "1.5.0",
      sforumBuild: "dev-abc12",
      os: "linux",
      arch: "amd64",
      platform: "all",
      compat: "all",
      q: "mark",
      category: "content",
      kind: "plugin",
      // Sorted, so the same set in another order is the same query (and the same ETag).
      extensionIds: ["sforum.markdown", "sforum.theme-paper"],
      cursor: null,
      limit: 5,
    });
  });

  test("treats blank values as absent", () => {
    const parsed = parseCatalogQuery(
      new URLSearchParams({ channel: "", sforum: " ", q: "", limit: "" }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.query.channel).toBeNull();
    expect(parsed.query.sforum).toBeNull();
    expect(parsed.query.q).toBeNull();
    expect(parsed.query.limit).toBe(18);
  });

  test("reads extensionIds as a sorted, de-duplicated batch filter", () => {
    const parsed = parseCatalogQuery(
      new URLSearchParams({
        extensionIds: " sforum.theme-paper, sforum.markdown ,,sforum.theme-paper",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.query.extensionIds).toEqual(["sforum.markdown", "sforum.theme-paper"]);
  });

  test("treats an absent or blank extensionIds as no filter", () => {
    for (const value of [null, "", "   ", ",", " , , "]) {
      const params = new URLSearchParams();
      if (value !== null) params.set("extensionIds", value);
      const parsed = parseCatalogQuery(params);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.query.extensionIds).toBeNull();
    }
  });

  test("rejects malformed extensionIds", () => {
    for (const value of [
      "SForum.markdown",
      "-leading",
      "sforum/markdown",
      "sforum markdown",
      "a".repeat(161),
      "sforum.markdown;",
    ]) {
      expect(parseCatalogQuery(new URLSearchParams({ extensionIds: value }))).toEqual({
        ok: false,
        code: "invalid_query",
      });
    }
    // 160 characters is the grammar's upper bound, not an off-by-one rejection.
    expect(parseExtensionIds("a".repeat(160)).ok).toBe(true);
  });

  test("caps extensionIds at 200 distinct values", () => {
    const batch = (count: number) =>
      Array.from({ length: count }, (_, index) => `sforum.id-${index}`).join(",");

    const boundary = parseExtensionIds(batch(MAX_EXTENSION_IDS));
    expect(boundary.ok).toBe(true);
    if (boundary.ok) expect(boundary.ids).toHaveLength(MAX_EXTENSION_IDS);

    // Repeating a value must not count against the cap: it is still one distinct id.
    expect(parseExtensionIds(`${batch(MAX_EXTENSION_IDS)},sforum.id-0`).ok).toBe(true);

    expect(parseExtensionIds(batch(MAX_EXTENSION_IDS + 1))).toEqual({ ok: false });
  });

  test("accepts the limit boundaries", () => {
    for (const limit of ["1", "100"]) {
      const parsed = parseCatalogQuery(new URLSearchParams({ limit }));
      expect(parsed.ok).toBe(true);
    }
  });

  test("rejects an invalid channel, compat, limit or oversized q", () => {
    const cases: Record<string, string>[] = [
      { channel: "nightly" },
      { compat: "strict" },
      { limit: "0" },
      { limit: "101" },
      { limit: "-1" },
      { limit: "ten" },
      { limit: "1.5" },
      { q: "x".repeat(121) },
      { kind: "extension" },
      { platform: "any" },
      { platform: "ALL" },
    ];
    for (const params of cases) {
      expect(parseCatalogQuery(new URLSearchParams(params))).toEqual({
        ok: false,
        code: "invalid_query",
      });
    }
  });

  test("rejects an unreadable cursor", () => {
    for (const cursor of ["!!!", "bm90IGpzb24", "e30"]) {
      expect(parseCatalogQuery(new URLSearchParams({ cursor }))).toEqual({
        ok: false,
        code: "invalid_cursor",
      });
    }
  });
});

describe("catalog visibility", () => {
  test("lists only published products with a usable published version", async () => {
    const { body } = await catalog();
    expect(body.items.map((item) => item.slug)).toEqual(VISIBLE_SLUGS);
    expect(body.total).toBe(VISIBLE_SLUGS.length);
    expect(body.nextCursor).toBeNull();
  });

  test("filters by kind and reports the filtered total", async () => {
    expect(await slugs({ kind: "theme" })).toEqual(["paper"]);

    const plugins = await catalog({ kind: "plugin" });
    expect(plugins.body.total).toBe(VISIBLE_SLUGS.length - 1);
    expect(plugins.body.items.every((item) => item.kind === "plugin")).toBe(true);
  });

  test("keeps a degraded upstream listed but drops a disconnected one", async () => {
    const listed = await slugs();
    expect(listed).toContain("paper");
    expect(listed).not.toContain("legacy");
  });

  test("hides draft, pending_review and versionless products", async () => {
    const listed = await slugs();
    expect(listed).not.toContain("draft");
    expect(listed).not.toContain("pending");
    expect(listed).not.toContain("empty");
    expect(listed).not.toContain("yanked-only");
    expect(listed).not.toContain("broken");
  });

  test("totals, ordering and shape of a summary row", async () => {
    const { body } = await catalog();
    const markdown = body.items[0];
    expect(markdown).toEqual({
      slug: "markdown",
      extensionId: "sforum.markdown",
      name: "Markdown 增强",
      kind: "plugin",
      summary: "更强的编辑体验",
      category: "content",
      tags: ["editor", "markdown"],
      iconUrl: `/api/assets/${sha("icon-markdown")}`,
      socialImageUrl: `/api/assets/${sha("card-markdown")}`,
      latestVersion: "2.0.0-beta.1",
      sforumVersion: ">=2.0.0-0 <3.0.0",
      updatedAt: "2026-10-01T00:00:00.000Z",
      platforms: [
        { os: "darwin", arch: "arm64" },
        { os: "linux", arch: "amd64" },
      ],
      // The card names 2.0.0-beta.1, which ships both; `platforms` above is the union over
      // every candidate, so here the two happen to agree.
      latestPlatforms: [
        { os: "darwin", arch: "arm64" },
        { os: "linux", arch: "amd64" },
      ],
      compatibility: { status: "unknown", estimated: false },
      author: {
        username: "ada",
        displayName: "Ada Lovelace",
        avatarUrl: null,
        // Trailing slash on the issuer base URL is trimmed exactly once.
        profileUrl: "https://forum.test/u/ada",
        github: { login: "acme", url: "https://github.com/acme" },
      },
    });
  });

  test("only a product with a brand card carries a social image", async () => {
    const { body } = await catalog();
    const markdown = body.items.find((item) => item.slug === "markdown");
    const mixed = body.items.find((item) => item.slug === "mixed");
    expect(markdown?.socialImageUrl).toBe(`/api/assets/${sha("card-markdown")}`);
    expect(mixed?.socialImageUrl).toBeNull();
  });

  test("the summary carries the named version's own constraint, not a verdict", async () => {
    const { body } = await catalog();
    const markdown = body.items.find((item) => item.slug === "markdown");
    // No host version was supplied, and the requirement is still published: it is a
    // manifest fact about the package, so it survives `compatibility: unknown`.
    expect(markdown?.latestVersion).toBe("2.0.0-beta.1");
    expect(markdown?.sforumVersion).toBe(">=2.0.0-0 <3.0.0");

    // `mixed` declares an unparsable constraint on 3.0.0, so that row is not a candidate
    // at all: neither its version nor its text may become the headline requirement.
    const mixed = body.items.find((item) => item.slug === "mixed");
    expect(mixed?.latestVersion).toBe("1.0.0");
    expect(mixed?.sforumVersion).toBe(">=3.0.0");
  });

  test("falls back to the product name and an empty summary", async () => {
    const { body } = await catalog();
    const paper = body.items.find((item) => item.slug === "paper");
    expect(paper?.name).toBe("纸张主题");
    expect(paper?.summary).toBe("轻量纸张主题");
    expect(paper?.iconUrl).toBeNull();
    expect(paper?.author?.displayName).toBe("Grace Hopper");

    const mixed = body.items.find((item) => item.slug === "mixed");
    expect(mixed?.name).toBe("Mixed");
    expect(mixed?.summary).toBe("");
    // Bounds to a repository but not to a forum account: the GitHub half still exists, and
    // the missing half stays missing instead of being filled from the other.
    expect(mixed?.author).toEqual({
      username: null,
      displayName: null,
      avatarUrl: null,
      profileUrl: null,
      github: { login: "acme", url: "https://github.com/acme" },
    });
    expect(mixed?.category).toBe("ops");
  });

  test("returns an empty page instead of failing on an empty database", async () => {
    await pool.query(TRUNCATE_ALL);
    const response = await catalogGET(new Request(catalogUrl()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [],
      total: 0,
      nextCursor: null,
      compatibility: { status: "unknown", estimated: false },
      compat: "compatible",
    });
  });
});

describe("compatibility", () => {
  test("an absent sforum never filters and reports unknown", async () => {
    const { body } = await catalog();
    expect(body.total).toBe(VISIBLE_SLUGS.length);
    expect(body.compatibility).toEqual({ status: "unknown", estimated: false });
    for (const item of body.items) {
      expect(item.compatibility).toEqual({ status: "unknown", estimated: false });
    }
  });

  test("an invalid sforum never filters either", async () => {
    for (const sforum of ["1.5", "garbage", "dev"]) {
      const { body } = await catalog({ sforum });
      expect(body.total).toBe(VISIBLE_SLUGS.length);
      expect(body.compatibility).toEqual({ status: "unknown", estimated: false });
      expect(body.items.every((item) => item.compatibility.status === "unknown")).toBe(true);
    }
  });

  test("a valid sforum filters with Masterminds semantics", async () => {
    const { body } = await catalog({ sforum: "1.5.0" });
    expect(body.items.map((item) => item.slug)).toEqual([
      "markdown",
      "paper",
      "mac-only",
      "percent",
      "arch-shift",
    ]);
    expect(body.total).toBe(5);
    expect(body.compatibility).toEqual({ status: "compatible", estimated: false });

    const markdown = body.items.find((item) => item.slug === "markdown");
    expect(markdown?.compatibility).toEqual({
      status: "compatible",
      estimated: false,
      constraint: ">=1.2.0, <2.0.0",
    });
  });

  test("compat=all flags incompatible items with the satisfied constraint", async () => {
    const { body } = await catalog({ sforum: "1.5.0", compat: "all" });
    expect(body.total).toBe(VISIBLE_SLUGS.length);

    const bySlug = new Map(body.items.map((item) => [item.slug, item]));
    expect(bySlug.get("mixed")?.compatibility).toEqual({
      status: "incompatible",
      estimated: false,
    });
    expect(bySlug.get("paper")?.compatibility).toEqual({
      status: "compatible",
      estimated: false,
      constraint: ">=1.0.0",
    });
  });

  test("a dev build estimates 1.0.0 and says so", async () => {
    // `catalog` passes compat explicitly, so this is the "explicit compatible" path too.
    const { body } = await catalog({ sforumBuild: "dev-abc12" });
    expect(body.compatibility).toEqual({ status: "compatible", estimated: true });
    for (const item of body.items) {
      expect(item.compatibility.estimated).toBe(true);
    }
    expect(body.items.map((item) => item.slug)).toEqual([
      "paper",
      "mac-only",
      "percent",
      "arch-shift",
    ]);
  });

  test("a dev build defaults to compat=all and drops nothing", async () => {
    const body = await catalogPage({ sforum: "1.5.0", sforumBuild: "dev-abc12" });
    expect(body.compat).toBe("all");
    expect(body.items.map((item) => item.slug)).toEqual(VISIBLE_SLUGS);
    // Unfiltered is not the same as "compatible": each card still carries its own verdict.
    expect(body.items.find((item) => item.slug === "mixed")?.compatibility).toEqual({
      status: "incompatible",
      estimated: true,
    });
  });

  test("a non-dev build still defaults to compat=compatible", async () => {
    const body = await catalogPage({ sforum: "1.5.0" });
    expect(body.compat).toBe("compatible");
    expect(body.items.map((item) => item.slug)).toEqual([
      "markdown",
      "paper",
      "mac-only",
      "percent",
      "arch-shift",
    ]);
  });

  test("an explicit compat=compatible on a dev build still filters", async () => {
    const body = await catalogPage({
      sforum: "1.5.0",
      sforumBuild: "dev-abc12",
      compat: "compatible",
    });
    expect(body.compat).toBe("compatible");
    expect(body.items.map((item) => item.slug)).toEqual([
      "markdown",
      "paper",
      "mac-only",
      "percent",
      "arch-shift",
    ]);
  });

  // The host's real dev shape is a tag-derived version carrying build metadata
  // (`3.0.16+13.g6f94488ad`). The dev tests above drive `sforum=1.5.0`, which never exercises
  // that string - and the whole point of this round is that this shape is not filtered away.
  test("the real dev version string defaults to compat=all", async () => {
    const body = await catalogPage({
      sforum: "3.0.16+13.g6f94488ad",
      sforumBuild: "dev-6f94488ad",
    });
    expect(body.compat).toBe("all");
    expect(body.compatibility).toEqual({ status: "compatible", estimated: true });
    expect(body.items.map((item) => item.slug)).toEqual([
      "markdown",
      "paper",
      "mixed",
      "mac-only",
      "percent",
      "oauth2-provider",
      "future",
      "arch-shift",
    ]);
  });

  test("an explicit compat=compatible keeps oauth2-provider on the real dev version", async () => {
    const body = await catalogPage({
      sforum: "3.0.16+13.g6f94488ad",
      sforumBuild: "dev-6f94488ad",
      compat: "compatible",
    });
    expect(body.compat).toBe("compatible");
    // Two products drop: `markdown` (stable needs <2.0.0, beta needs <3.0.0) and `future`
    // (needs >=4.0.0). The tag-derived version still satisfies oauth2-provider's
    // `>=3.0.12-alpha.7`, which is the case this round was opened for.
    expect(body.items.map((item) => item.slug)).toEqual([
      "paper",
      "mixed",
      "mac-only",
      "percent",
      "oauth2-provider",
      "arch-shift",
    ]);
  });

  test("a non-dev host with build metadata still defaults to compatible", async () => {
    const body = await catalogPage({ sforum: "3.0.16+13.g6f94488ad", sforumBuild: "3.0.16" });
    expect(body.compat).toBe("compatible");
    expect(body.compatibility).toEqual({ status: "compatible", estimated: false });
    expect(body.items.map((item) => item.slug)).toEqual([
      "paper",
      "mixed",
      "mac-only",
      "percent",
      "oauth2-provider",
      "arch-shift",
    ]);
  });

  test("estimated stays true when a dev build also reports a real version", async () => {
    const { body } = await catalog({ sforum: "1.5.0", sforumBuild: "dev-abc12" });
    expect(body.compatibility).toEqual({ status: "compatible", estimated: true });
    expect(body.total).toBe(5);
  });

  test("os/arch narrowing requires an asset on the satisfying version", async () => {
    const linux = await slugs({
      sforum: "1.5.0",
      os: "linux",
      arch: "amd64",
    });
    expect(linux).toEqual(["markdown", "paper", "percent", "arch-shift"]);

    const darwin = await slugs({
      sforum: "1.5.0",
      os: "darwin",
      arch: "arm64",
    });
    expect(darwin).toEqual(["paper", "mac-only", "percent", "arch-shift"]);
  });

  test("any/any is a platform wildcard, not a literal platform", async () => {
    // Themes ship no backend binary and are detected as any/any (plan §5.5); a host asking
    // for a concrete platform must still see them, otherwise filtering hides every theme.
    // The platform filter applies even without a host version: a host always knows its
    // GOOS/GOARCH, and only the version-compatibility axis is unknown then.
    const linux = await slugs({ os: "linux", arch: "amd64" });
    expect(linux).toEqual([
      "markdown",
      "paper",
      "mixed",
      "percent",
      "oauth2-provider",
      "future",
      "arch-shift",
    ]);

    const windows = await slugs({ os: "windows", arch: "amd64" });
    expect(windows).toEqual(["paper", "percent"]);
  });

  test("declared capabilities travel with every release", async () => {
    const detail = await loadProductDetail(db, "markdown");
    expect(detail?.releases.find((release) => release.version === "1.5.0")?.capabilities).toEqual([
      "host.api",
      "settings.own",
    ]);

    const releases = await listProductReleases(db, "markdown");
    expect(releases?.find((release) => release.version === "1.5.0")?.capabilities).toEqual([
      "host.api",
      "settings.own",
    ]);
    // No declaration still yields an array, never undefined.
    expect(releases?.find((release) => release.version === "1.0.0")?.capabilities).toEqual([]);
  });

  test("an unparsable manifest constraint neither counts nor hides the product", async () => {
    const { body } = await catalog({ sforum: "1.5.0", compat: "all" });
    const mixed = body.items.find((item) => item.slug === "mixed");
    expect(mixed).toBeDefined();
    expect(mixed?.latestVersion).toBe("1.0.0");

    const releases = await listProductReleases(db, "mixed");
    expect(releases?.map((release) => release.version)).toEqual(["1.0.0"]);
  });
});

describe("channel selection", () => {
  test("stable only counts stable versions", async () => {
    const { body } = await catalog({ channel: "stable" });
    expect(body.items.map((item) => item.slug)).toEqual(VISIBLE_SLUGS);
    const markdown = body.items.find((item) => item.slug === "markdown");
    expect(markdown?.latestVersion).toBe("1.5.0");
    expect(markdown?.sforumVersion).toBe(">=1.2.0, <2.0.0");
    expect(markdown?.platforms).toEqual([{ os: "linux", arch: "amd64" }]);
  });

  test("beta only counts beta versions", async () => {
    const { body } = await catalog({ channel: "beta" });
    expect(body.total).toBe(1);
    expect(body.items[0]?.slug).toBe("markdown");
    expect(body.items[0]?.latestVersion).toBe("2.0.0-beta.1");
  });

  test("the default channel takes the semver-greater of both", async () => {
    const { body } = await catalog();
    const markdown = body.items.find((item) => item.slug === "markdown");
    expect(markdown?.latestVersion).toBe("2.0.0-beta.1");
  });

  test("channel narrows compatibility too", async () => {
    // 2.5.0 only satisfies markdown's beta band, never its stable one.
    expect(await slugs({ sforum: "2.5.0", channel: "beta" })).toEqual(["markdown"]);
    expect(await slugs({ sforum: "2.5.0", channel: "stable" })).toEqual([
      "paper",
      "mac-only",
      "percent",
      "arch-shift",
    ]);
  });
});

describe("platform axis", () => {
  test("latestPlatforms describes the version the card names, not the union", async () => {
    const { body } = await catalog();
    const shifted = body.items.find((item) => item.slug === "arch-shift");
    // The card names 2.0.0, which only ships darwin/arm64; 1.0.0 still ships linux/amd64.
    // That difference is the whole reason the field exists: `platforms` alone would tell a
    // linux admin "something here runs for you" and hide the fact that the newest release
    // does not.
    expect(shifted?.latestVersion).toBe("2.0.0");
    expect(shifted?.latestPlatforms).toEqual([{ os: "darwin", arch: "arm64" }]);
    expect(shifted?.platforms).toEqual([
      { os: "darwin", arch: "arm64" },
      { os: "linux", arch: "amd64" },
    ]);
  });

  test("latestPlatforms is always a subset of platforms", async () => {
    const { body } = await catalog();
    for (const item of body.items) {
      const union = new Set(item.platforms.map((platform) => `${platform.os}/${platform.arch}`));
      for (const platform of item.latestPlatforms) {
        expect(`${item.slug}:${union.has(`${platform.os}/${platform.arch}`)}`).toBe(
          `${item.slug}:true`,
        );
      }
    }
  });

  test("omitting platform is exactly strict", async () => {
    const implicit = await slugs({ sforum: "1.5.0", os: "linux", arch: "amd64" });
    const explicit = await slugs({
      sforum: "1.5.0",
      os: "linux",
      arch: "amd64",
      platform: "strict",
    });
    expect(explicit).toEqual(implicit);
    // darwin-only products stay hidden in both.
    expect(implicit).not.toContain("mac-only");
  });

  test("platform=all keeps products this host cannot run and still reports them incompatible", async () => {
    const strict = await slugs({ sforum: "1.5.0", os: "linux", arch: "amd64" });
    expect(strict).not.toContain("mac-only");

    const widened = await catalog({
      sforum: "1.5.0",
      os: "linux",
      arch: "amd64",
      platform: "all",
    });
    expect(widened.body.items.map((item) => item.slug)).toContain("mac-only");
    // Widening is visibility only. The verdict stays platform-aware, so the card can still
    // say "this one is not installable here" instead of pretending the switch made it fit.
    expect(widened.body.items.find((item) => item.slug === "mac-only")?.compatibility).toEqual({
      status: "incompatible",
      estimated: false,
    });
  });

  test("platform=all still applies the version axis of compat", async () => {
    // `future` needs >=4.0.0, so a 1.5.0 host must not see it even in the widened list:
    // the switch is about architecture, not about core version.
    const widened = await slugs({
      sforum: "1.5.0",
      os: "linux",
      arch: "amd64",
      platform: "all",
    });
    expect(widened).not.toContain("future");
  });

  test("platform=all keeps the every-release detail page unchanged", async () => {
    // The detail page publishes every release regardless of platform; the client picks one.
    const detail = await loadProductDetail(db, "arch-shift");
    expect(detail?.latestPlatforms).toEqual([{ os: "darwin", arch: "arm64" }]);
    expect(detail?.releases.map((release) => release.version)).toEqual(["2.0.0", "1.0.0"]);
  });
});

describe("filters", () => {
  test("q matches name, extension id, translation, summary and owner case-insensitively", async () => {
    expect(await slugs({ q: "markdown" })).toEqual(["markdown"]);
    expect(await slugs({ q: "MARKDOWN" })).toEqual(["markdown"]);
    expect(await slugs({ q: "sforum.percent" })).toEqual(["percent"]);
    expect(await slugs({ q: "轻量纸张" })).toEqual(["paper"]);
    expect(await slugs({ q: "ADA" })).toEqual(["markdown"]);
    expect(await slugs({ q: "grace" })).toEqual(["paper"]);
  });

  test("q escapes SQL wildcards", async () => {
    expect(await slugs({ q: "100%" })).toEqual(["percent"]);
    expect(await slugs({ q: "%" })).toEqual(["percent"]);
    expect(await slugs({ q: "_" })).toEqual([]);
  });

  test("category matches exactly", async () => {
    expect(await slugs({ category: "content" })).toEqual(["markdown"]);
    expect(await slugs({ category: "ops" })).toEqual(["mixed"]);
    expect(await slugs({ category: "content " })).toEqual([]);
  });

  test("extensionIds keeps only the named products", async () => {
    const { body } = await catalog({
      extensionIds: ["sforum.theme-paper", "sforum.markdown"],
    });
    expect(body.items.map((item) => item.slug)).toEqual(["markdown", "paper"]);
    expect(body.total).toBe(2);
  });

  test("unknown extensionIds are ignored rather than fatal", async () => {
    const { body } = await catalog({
      extensionIds: ["sforum.markdown", "sforum.unknown"],
    });
    expect(body.items.map((item) => item.slug)).toEqual(["markdown"]);
    expect(body.total).toBe(1);
  });

  test("extensionIds composes with kind, channel and platform", async () => {
    const both = ["sforum.markdown", "sforum.theme-paper"];
    expect(await slugs({ extensionIds: both, kind: "theme" })).toEqual(["paper"]);
    // The theme ships stable only, so the channel axis still narrows the filtered set.
    expect(await slugs({ extensionIds: both, channel: "beta" })).toEqual(["markdown"]);

    // Platform visibility applies to the filtered set exactly as it does to the full list:
    // `strict` hides a product no candidate release supports on this host, `all` shows it.
    expect(
      await slugs({ extensionIds: ["sforum.mac-only"], os: "linux", arch: "amd64" }),
    ).toEqual([]);
    expect(
      await slugs({
        extensionIds: ["sforum.mac-only"],
        os: "linux",
        arch: "amd64",
        platform: "all",
      }),
    ).toEqual(["mac-only"]);
  });

  test("extensionIds narrows total and pagination", async () => {
    const both = ["sforum.markdown", "sforum.theme-paper"];
    const first = await catalog({ extensionIds: both, limit: 1 });
    expect(first.body.items).toHaveLength(1);
    expect(first.body.total).toBe(2);
    expect(first.body.nextCursor).not.toBeNull();

    const second = await catalog({
      extensionIds: both,
      limit: 1,
      cursor: first.body.nextCursor,
    });
    expect(second.body.items).toHaveLength(1);
    expect(second.body.total).toBe(2);
    expect(second.body.nextCursor).toBeNull();
  });

  test("extensionIds travels through the route parser", async () => {
    const body = await catalogPage({
      extensionIds: "sforum.theme-paper,sforum.markdown",
    });
    expect(body.items.map((item) => item.slug)).toEqual(["markdown", "paper"]);
    expect(body.total).toBe(2);
  });

  test("unknown filters yield an empty page", async () => {
    const { body } = await catalog({ q: "no-such-product" });
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.nextCursor).toBeNull();
  });
});

describe("pagination", () => {
  test("pages with a keyset cursor without duplicates or gaps", async () => {
    const first = await catalog({ limit: 2 });
    expect(first.body.items.map((item) => item.slug)).toEqual(["markdown", "paper"]);
    expect(first.body.total).toBe(VISIBLE_SLUGS.length);
    expect(first.body.nextCursor).not.toBeNull();

    const seen = first.body.items.map((item) => item.slug);
    let cursor = first.body.nextCursor;
    let pages = 1;
    while (cursor !== null) {
      const page = await catalog({ limit: 2, cursor });
      expect(page.body.total).toBe(VISIBLE_SLUGS.length);
      seen.push(...page.body.items.map((item) => item.slug));
      cursor = page.body.nextCursor;
      pages += 1;
    }
    expect(pages).toBe(Math.ceil(VISIBLE_SLUGS.length / 2));
    expect(seen).toHaveLength(VISIBLE_SLUGS.length);
    expect(new Set(seen).size).toBe(VISIBLE_SLUGS.length);
    expect([...seen].sort()).toEqual([...VISIBLE_SLUGS].sort());
  });

  test("total ignores limit and cursor", async () => {
    const single = await catalog({ limit: 1 });
    expect(single.body.items).toHaveLength(1);
    expect(single.body.total).toBe(VISIBLE_SLUGS.length);

    const beyond = await catalog({ limit: 2, cursor: single.body.nextCursor });
    expect(beyond.body.total).toBe(VISIBLE_SLUGS.length);
  });

  test("keeps a total order when updated_at collides", async () => {
    await db
      .update(products)
      .set({ updatedAt: at("2026-09-29") })
      .where(eq(products.slug, "paper"));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < VISIBLE_SLUGS.length; page += 1) {
      const { body } = await catalog({ limit: 1, cursor });
      expect(body.total).toBe(VISIBLE_SLUGS.length);
      seen.push(...body.items.map((item) => item.slug));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(VISIBLE_SLUGS.length);
    expect(new Set(seen).size).toBe(VISIBLE_SLUGS.length);
    expect(seen).toContain("paper");
    expect(seen).toContain("mixed");
  });

  test("a hand-built cursor resumes strictly after its boundary", async () => {
    const all = await catalog();
    const boundary = all.body.items[2];
    const [row] = await db
      .select({ id: products.id, updatedAt: products.updatedAt })
      .from(products)
      .where(eq(products.slug, boundary.slug));
    const cursor = encodeCursor({ updatedAt: row.updatedAt, id: row.id });

    const resumed = await catalog({ cursor });
    expect(resumed.body.items.map((item) => item.slug)).toEqual(
      all.body.items.slice(3).map((item) => item.slug),
    );
    expect(resumed.body.total).toBe(VISIBLE_SLUGS.length);
  });
});

describe("ETag and conditional requests", () => {
  test("a first request carries an ETag and replaying it answers 304 empty", async () => {
    const first = await catalogGET(new Request(catalogUrl({ sforum: "1.5.0" })));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe(CATALOG_CACHE_CONTROL);
    const tag = first.headers.get("etag");
    expect(tag).toMatch(/^"[0-9a-f]{64}"$/);

    const payload = await first.json();
    expect(payload.total).toBe(5);

    const second = await catalogGET(
      new Request(catalogUrl({ sforum: "1.5.0" }), {
        headers: { "if-none-match": tag as string },
      }),
    );
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(tag);
    expect(second.headers.get("cache-control")).toBe(CATALOG_CACHE_CONTROL);
  });

  test("accepts weak and comma-separated validators", async () => {
    const url = catalogUrl();
    const tag = (await catalogGET(new Request(url))).headers.get("etag") as string;

    for (const header of [`W/${tag}`, `"other", ${tag}`, `W/${tag}, "other"`]) {
      const response = await catalogGET(new Request(url, { headers: { "if-none-match": header } }));
      expect(response.status).toBe(304);
    }

    const miss = await catalogGET(
      new Request(url, { headers: { "if-none-match": '"stale"' } }),
    );
    expect(miss.status).toBe(200);
  });

  test("every query dimension changes the validator", async () => {
    const variants: [string, Partial<CatalogQuery>, Partial<CatalogQuery>][] = [
      ["sforum", { sforum: "1.5.0" }, { sforum: "2.5.0" }],
      [
        "sforumBuild",
        { sforum: "1.5.0", sforumBuild: "dev-aaa" },
        { sforum: "1.5.0", sforumBuild: "dev-bbb" },
      ],
      ["os", { os: "linux" }, { os: "darwin" }],
      ["arch", { arch: "amd64" }, { arch: "arm64" }],
      // No os/arch here on purpose: both modes then return the same rows, so this only
      // passes when `platform` is part of the fingerprint. A shared validator would serve
      // the strict body under an `all` request (plan §11).
      ["platform", { platform: "strict" }, { platform: "all" }],
      ["channel", { channel: "stable" }, { channel: "beta" }],
      [
        "compat",
        { sforum: "1.5.0", compat: "compatible" },
        { sforum: "1.5.0", compat: "all" },
      ],
      ["q", { q: "markdown" }, { q: null }],
      ["category", { category: "content" }, { category: null }],
      // Same rows, different filter set: only the fingerprint can tell these apart.
      [
        "extensionIds",
        { extensionIds: ["sforum.markdown"] },
        { extensionIds: ["sforum.markdown", "sforum.unknown"] },
      ],
      ["limit", { limit: 18 }, { limit: 100 }],
    ];

    for (const [name, left, right] of variants) {
      const a = await catalog(left);
      const b = await catalog(right);
      expect(`${name}:${a.etag === b.etag}`).toBe(`${name}:false`);
    }
  });

  test("extensionIds order does not change the validator", async () => {
    const a = await catalog({ extensionIds: ["sforum.markdown", "sforum.theme-paper"] });
    const b = await catalog({ extensionIds: ["sforum.theme-paper", "sforum.markdown"] });
    expect(a.body.items.map((item) => item.slug)).toEqual(
      b.body.items.map((item) => item.slug),
    );
    expect(a.etag).toBe(b.etag);
  });

  test("the page cursor changes the validator", async () => {
    const first = await catalog({ limit: 2 });
    const second = await catalog({ limit: 2, cursor: first.body.nextCursor });
    expect(first.etag).not.toBe(second.etag);
  });

  test("etagForJson and ifNoneMatchMatches behave", () => {
    expect(etagForJson({ a: 1 })).toBe(etagForJson({ a: 1 }));
    expect(etagForJson({ a: 1 })).not.toBe(etagForJson({ a: 2 }));
    expect(etagForJson({ a: 1 }, "x")).not.toBe(etagForJson({ a: 1 }, "y"));

    expect(ifNoneMatchMatches(null, "abc")).toBe(false);
    expect(ifNoneMatchMatches('"abc"', "abc")).toBe(true);
    expect(ifNoneMatchMatches('W/"abc"', "abc")).toBe(true);
    expect(ifNoneMatchMatches('"nope", "abc"', "abc")).toBe(true);
    expect(ifNoneMatchMatches("*", "abc")).toBe(true);
    expect(ifNoneMatchMatches('"abcd"', "abc")).toBe(false);
  });
});

describe("catalog route errors", () => {
  test("invalid query parameters answer 400 without caching", async () => {
    for (const params of [
      { channel: "nightly" },
      { compat: "strict" },
      { limit: "0" },
      { limit: "101" },
      { limit: "abc" },
      { extensionIds: "SForum.markdown" },
    ]) {
      const response = await catalogGET(new Request(catalogUrl(params)));
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        code: "invalid_query",
        message: "query parameters are not acceptable",
      });
    }
  });

  test("an unreadable cursor answers 400 invalid_cursor", async () => {
    const response = await catalogGET(new Request(catalogUrl({ cursor: "!!!" })));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "invalid_cursor",
      message: "pagination cursor is not readable",
    });
  });
});

describe("product detail", () => {
  test("assembles translations, preview, author, repo, README and releases", async () => {
    const detail = await loadProductDetail(db, "markdown");
    expect(detail).not.toBeNull();
    if (!detail) return;

    expect(detail.name).toBe("Markdown 增强");
    expect(detail.summary).toBe("更强的编辑体验");
    expect(detail.iconUrl).toBe(`/api/assets/${sha("icon-markdown")}`);
    expect(detail.author?.displayName).toBe("Ada Lovelace");
    expect(detail.author?.username).toBe("ada");
    expect(detail.author?.profileUrl).toBe("https://forum.test/u/ada");
    expect(detail.repoUrl).toBe("https://github.com/acme/markdown");
    expect(detail.readme).toEqual({
      html: "<h1>Markdown</h1>\n<p>支持 GFM。</p>",
      sourceUrl: "https://github.com/acme/markdown/blob/HEAD/README.md",
      sha: sha("readme-markdown"),
      fetchedAt: "2026-10-01T00:00:00.000Z",
      byteSize: 24,
    });
    expect(detail.releases.map((release) => release.version)).toEqual([
      "2.0.0-beta.1",
      "1.5.0",
      "1.0.0",
    ]);
    expect(detail.releases.map((release) => release.status)).toEqual([
      "published",
      "published",
      "yanked",
    ]);
  });

  test("publishes rendered notes HTML next to the raw Markdown source", async () => {
    const release = await getProductRelease(db, "markdown", "1.0.0");
    expect(release?.notes).toContain("## 变更");
    // `##` becomes `h4`: the dialog's own title is `h2` and each release head is `h3`.
    expect(release?.notesHtml).toContain("<h4");
    expect(release?.notesHtml).toContain("支持 GFM 表格");
    expect(release?.notesHtml).toContain('class="readme-code"');
    expect(release?.notesHtml).not.toContain("<h2");
  });

  test("keeps notes and notesHtml absent together when a release has no body", async () => {
    const release = await getProductRelease(db, "markdown", "2.0.0-beta.1");
    expect(release?.notes ?? null).toBeNull();
    expect(release?.notesHtml ?? null).toBeNull();
  });

  test("has no author block when neither a forum account nor a repository is bound", async () => {
    const detail = await loadProductDetail(db, "percent");
    expect(detail?.author ?? null).toBeNull();
  });

  test("hides a README cached from a repository the product is no longer bound to", async () => {
    // `paper` is bound to repo 200; the cache row was fetched from 201 before a rebind.
    const [paper] = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.slug, "paper"));
    await db.insert(productReadmes).values({
      productId: paper!.id,
      repoId: 201,
      ref: "HEAD",
      path: "README.md",
      blobSha: sha("stale-readme"),
      markdown: "# Old project",
      html: "<h1>Old project</h1>",
      byteSize: 20,
      fetchedAt: at("2026-09-01"),
    });

    const detail = await loadProductDetail(db, "paper");
    expect(detail).not.toBeNull();
    expect(detail?.readme).toBeNull();
  });

  test("a product with no cached README publishes readme: null", async () => {
    const detail = await loadProductDetail(db, "paper");
    expect(detail?.readme).toBeNull();
  });

  test("never exposes an upstream download address", async () => {
    const detail = await loadProductDetail(db, "markdown");
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("browser_download_url");
    expect(serialized).not.toContain("api.github.com");
    expect(serialized).not.toContain("installations");
    // Four web addresses are allowed, and each one is a *page* the operator can visit:
    // the repository, the README blob the rendered HTML came from, the maintainer's GitHub
    // account (built from the installation login), and the maintainer's forum profile (built
    // from the issuer base URL registered in `oauth_issuers`). None of them comes from a URL
    // a caller supplied. No asset host, no download URL.
    expect([...serialized.matchAll(/https?:\/\/[^"\\]+/g)].map((match) => match[0]).sort()).toEqual([
      "https://forum.test/u/ada",
      "https://github.com/acme",
      "https://github.com/acme/markdown",
      "https://github.com/acme/markdown/blob/HEAD/README.md",
    ]);
  });

  test("a product without a repo has no repo url and no README", async () => {
    const detail = await loadProductDetail(db, "percent");
    expect(detail?.name).toBe("100% Off");
    expect(detail?.repoUrl).toBeNull();
    expect(detail?.readme).toBeNull();
  });

  test("reports compatibility for a known host", async () => {
    const compatible = await loadProductDetail(db, "markdown", { sforum: "1.5.0" });
    expect(compatible?.compatibility).toEqual({
      status: "compatible",
      estimated: false,
      constraint: ">=1.2.0, <2.0.0",
    });

    const incompatible = await loadProductDetail(db, "mixed", { sforum: "1.5.0" });
    expect(incompatible?.compatibility).toEqual({
      status: "incompatible",
      estimated: false,
    });
  });

  test("returns null for products outside the catalog", async () => {
    for (const slug of ["draft", "pending", "legacy", "empty", "broken", "yanked-only", "nope"]) {
      expect(await loadProductDetail(db, slug)).toBeNull();
    }
  });

  test("answers 404 with an error body and no caching", async () => {
    const context: RouteContext<{ slug: string }> = {
      params: Promise.resolve({ slug: "draft" }),
    };
    const response = await productGET(
      new Request("http://localhost/api/v1/products/draft"),
      context,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      code: "not_found",
      message: "product not found",
    });
  });

  test("answers 200 with an ETag for a published product", async () => {
    const response = await productGET(
      new Request("http://localhost/api/v1/products/markdown"),
      { params: Promise.resolve({ slug: "markdown" }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    const body = await response.json();
    expect(body.slug).toBe("markdown");
  });
});

describe("release history", () => {
  test("orders by semver descending and includes yanked versions", async () => {
    const releases = await listProductReleases(db, "markdown");
    expect(releases?.map((release) => release.version)).toEqual([
      "2.0.0-beta.1",
      "1.5.0",
      "1.0.0",
    ]);
    expect(releases?.[0]?.assets.map((asset) => `${asset.os}/${asset.arch}`)).toEqual([
      "darwin/arm64",
      "linux/amd64",
    ]);
  });

  test("omits the digest for multi-asset versions and keeps it for single ones", async () => {
    const releases = await listProductReleases(db, "markdown");
    const multi = releases?.find((release) => release.version === "2.0.0-beta.1");
    const single = releases?.find((release) => release.version === "1.5.0");
    expect(multi?.digest).toBeUndefined();
    expect(single?.digest).toBe(sha("md-1500"));
    expect(single?.notes).toBeNull();
    expect(single?.notesHtml).toBeNull();
    // A yanked release keeps its body: the text is what a reader needs in order to judge
    // whether the withdrawn version is the one they already run.
    expect(releases?.find((release) => release.version === "1.0.0")?.notes).toContain("## 变更");
  });

  test("falls back to created_at when published_at is null", async () => {
    const releases = await listProductReleases(db, "mac-only");
    const [row] = await db
      .select({ createdAt: releaseVersions.createdAt })
      .from(releaseVersions)
      .where(eq(releaseVersions.version, "1.0.0"));
    expect(releases?.[0]?.publishedAt).toBe(row?.createdAt.toISOString());
  });

  test("never exposes needs_attention versions", async () => {
    const releases = await listProductReleases(db, "paper");
    expect(releases?.map((release) => release.version)).toEqual(["2.0.0"]);

    const { body } = await catalog();
    const paper = body.items.find((item) => item.slug === "paper");
    expect(paper?.latestVersion).toBe("2.0.0");
    expect(paper?.platforms).toEqual([{ os: "any", arch: "any" }]);
  });

  test("a yanked release stays readable with its status", async () => {
    const release = await getProductRelease(db, "markdown", "1.0.0");
    expect(release?.status).toBe("yanked");
    expect(release?.digest).toBe(sha("md-1000"));
  });

  test("filters by channel and returns null for a hidden product", async () => {
    expect((await listProductReleases(db, "markdown", { channel: "beta" }))?.length).toBe(1);
    expect((await listProductReleases(db, "markdown", { channel: "stable" }))?.length).toBe(2);
    expect(await listProductReleases(db, "draft")).toBeNull();
    expect(await listProductReleases(db, "legacy")).toBeNull();
  });

  test("answers 404 for a hidden product and 400 for a bad channel", async () => {
    const hidden = await productReleasesGET(
      new Request("http://localhost/api/v1/products/draft/releases"),
      { params: Promise.resolve({ slug: "draft" }) },
    );
    expect(hidden.status).toBe(404);

    const badChannel = await productReleasesGET(
      new Request("http://localhost/api/v1/products/markdown/releases?channel=nightly"),
      { params: Promise.resolve({ slug: "markdown" }) },
    );
    expect(badChannel.status).toBe(400);
    expect((await badChannel.json()).code).toBe("invalid_query");

    const ok = await productReleasesGET(
      new Request("http://localhost/api/v1/products/markdown/releases?channel=beta"),
      { params: Promise.resolve({ slug: "markdown" }) },
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    expect((await ok.json()).length).toBe(1);
  });
});

describe("single release", () => {
  test("matches the manifest version exactly", async () => {
    const release = await getProductRelease(db, "markdown", "1.5.0");
    expect(release?.version).toBe("1.5.0");
    expect(release?.channel).toBe("stable");
    expect(release?.sforumVersion).toBe(">=1.2.0, <2.0.0");
    expect(release?.assets).toEqual([
      {
        os: "linux",
        arch: "amd64",
        filename: "markdown-1.5.0-linux-amd64.zip",
        size: 4096,
        sha256: sha("md-1500"),
      },
    ]);
    expect(release?.digest).toBe(sha("md-1500"));
    expect(release?.publishedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  test("does not tolerate a v prefix", async () => {
    expect(await getProductRelease(db, "markdown", "v1.5.0")).toBeNull();
    expect(await getProductRelease(db, "markdown", "9.9.9")).toBeNull();
    expect(await getProductRelease(db, "mixed", "3.0.0")).toBeNull();
  });

  test("answers 404 through the route", async () => {
    const response = await productReleaseGET(
      new Request("http://localhost/api/v1/products/markdown/releases/v1.5.0"),
      { params: Promise.resolve({ slug: "markdown", version: "v1.5.0" }) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "not_found",
      message: "release not found",
    });

    const found = await productReleaseGET(
      new Request("http://localhost/api/v1/products/markdown/releases/2.0.0-beta.1"),
      { params: Promise.resolve({ slug: "markdown", version: "2.0.0-beta.1" }) },
    );
    expect(found.status).toBe(200);
    expect(found.headers.get("cache-control")).toBe(CATALOG_CACHE_CONTROL);
  });
});
