/**
 * Local dev preview seed. Not part of the build: run it by hand with
 * `bun run seed:dev` (which loads `.env.local`). Every row here exists so the
 * storefront has something to render after a fresh migration — nothing in
 * `src/` imports this file.
 *
 * Idempotent: all writes upsert on the natural keys the schema already pins
 * (`accounts(issuer_key, sub)`, `products.extension_id`, `products.slug`,
 * `repo_releases(repo_id, tag)`, `release_versions(product_id, version)`,
 * `release_assets(release_version_id, os, arch)`, `assets.sha256`), so a second
 * run converges instead of duplicating.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

import { closeDb, getDb } from "@/db/client";
import { renderReadme } from "@/lib/readme/render";
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
import { getConfig } from "@/lib/config";
import { encryptSecret } from "@/lib/crypto";
import { isCategoryKey } from "@/lib/products/taxonomy";

import { recomputeProductLatestVersions } from "../src/lib/products/latest";

if (!process.env.DATABASE_URL) {
  console.error(
    [
      "seed:dev 需要 DATABASE_URL。",
      "本仓库的约定是从 service/.env.local 读取：",
      "  cd service && bun run seed:dev",
      "（等价于 bun --env-file=.env.local scripts/seed-dev.ts）",
    ].join("\n"),
  );
  process.exit(1);
}

const REPO_ID = 4242;
const INSTALLATION_ID = 42;
const PUBLISHED = new Date("2026-10-23T08:00:00Z");

// ---------------------------------------------------------------------------
// PNG writer: 8-bit truecolour (RGB), one IDAT, correct CRC32 per chunk.
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

type Rgb = [number, number, number];

function makePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Rgb,
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 3 + 1; // leading filter byte per scanline
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter type 0 (None)
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const offset = rowStart + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const INK: Rgb = [32, 36, 40];
const PAPER: Rgb = [246, 247, 248];
const LINE: Rgb = [206, 210, 214];
const MOSS: Rgb = [64, 96, 78];

/** Abstract app mark: dark field, inset paper square, moss accent bar. */
function iconPng(): Buffer {
  const size = 256;
  return makePng(size, size, (x, y) => {
    const inset = x > 64 && x < 192 && y > 64 && y < 192;
    if (!inset) return INK;
    const accent = y > 148 && y < 164 && x > 88 && x < 168;
    if (accent) return MOSS;
    const notch = y > 96 && y < 112 && x > 88 && x < 140;
    if (notch) return LINE;
    return PAPER;
  });
}


// ---------------------------------------------------------------------------
// Content-addressed storage
// ---------------------------------------------------------------------------

const sha256Hex = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

const assetRoot = () =>
  process.env.STORE_ASSET_DIR ||
  path.join(process.cwd(), ".data", "assets");

type StoredAsset = { sha256: string; storageKey: string; written: boolean };

function storePng(bytes: Buffer): StoredAsset {
  const sha256 = sha256Hex(bytes);
  const storageKey = `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
  const target = path.join(assetRoot(), storageKey);
  if (existsSync(target)) return { sha256, storageKey, written: false };
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: "wx" });
  return { sha256, storageKey, written: true };
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

type SeedVersion = {
  version: string;
  channel: "stable" | "beta";
  state: "published" | "yanked";
  constraint: string;
  capabilities: string[];
  notes: string;
  /** Optional manifest metadata; defaults are derived from the product below. */
  manifest?: {
    description?: string;
    url?: string;
    author?: { name?: string; url?: string };
    langs?: Record<
      string,
      { name?: string; description?: string; url?: string }
    >;
  };
  publishedAt: Date;
  yankReason?: string;
  platforms: { os: string; arch: string; detection: "buildinfo" | "manifest" }[];
};

type SeedProduct = {
  extensionId: string;
  slug: string;
  kind: "plugin" | "theme";
  category: string;
  ownerSub: string;
  name: string;
  summary: string;
  /** Rendered into the product page exactly as a repository README would be. */
  readme: string;
  tags: string[];
  preview: boolean;
  updatedAt: Date;
  versions: SeedVersion[];
};

const LINUX_AMD64 = { os: "linux", arch: "amd64", detection: "buildinfo" as const };
const LINUX_ARM64 = { os: "linux", arch: "arm64", detection: "buildinfo" as const };
const DARWIN_ARM64 = { os: "darwin", arch: "arm64", detection: "buildinfo" as const };
const ANY = { os: "any", arch: "any", detection: "manifest" as const };

/**
 * One README for every seeded product.
 *
 * It exercises what the renderer must survive: a heading (demoted one level), a table, a
 * fenced block, a task list, `<details>`, and a relative image. The image deliberately points
 * at a repository that does not exist, so a broken preview is visible rather than hidden.
 */
const SEED_README = [
  "## 这个扩展做什么",
  "",
  "把 SForum 的 Markdown 渲染换成 CommonMark 加 GFM 子集。渲染在服务端完成，前端不加载脚本；",
  "不接管编辑器，也不改草稿存储。停用插件后，已有内容按论坛默认渲染器显示。",
  "",
  "### 支持范围",
  "",
  "| 语法 | 状态 | 备注 |",
  "| --- | --- | --- |",
  "| 表格 | 支持 | 窄屏横向滚动 |",
  "| 任务列表 | 支持 | 只读渲染 |",
  "| 脚注 | 支持 | 需要开启设置 |",
  "",
  "### 配置",
  "",
  "```json",
  '{ "enableFootnotes": true, "maxNesting": 6 }',
  "```",
  "",
  "- [x] 表格与任务列表",
  "- [ ] 数学公式（不在本版本范围）",
  "",
  "<details>",
  "<summary>已知限制</summary>",
  "",
  "不接管编辑器；草稿仍然以论坛默认格式存储。",
  "",
  "</details>",
  "",
  "![目录截图](./docs/overview.png)",
].join("\n");

const PRODUCTS: SeedProduct[] = [
  {
    extensionId: "sforum.markdown-plus",
    slug: "markdown-plus",
    kind: "plugin",
    category: "content",
    ownerSub: "dev-1",
    name: "Markdown Plus",
    summary: "CommonMark + GFM 渲染：表格、任务列表、脚注与代码高亮。",
    readme: SEED_README,
    tags: ["markdown", "render"],
    preview: true,
    updatedAt: new Date("2026-10-23T07:41:00Z"),
    versions: [
      {
        version: "1.4.2",
        channel: "stable",
        state: "published",
        constraint: ">=1.2.0 <2.0.0",
        capabilities: ["content.render", "host.api", "settings.own"],
        notes: "修复表格列宽在窄屏下的抖动；自动链接识别补上 GFM 扩展。",
        manifest: {
          description: "CommonMark + GFM 渲染，带表格、任务列表与代码高亮。",
          url: "https://github.com/sforum-apps/markdown-plus",
          author: { name: "SForum Apps", url: "https://github.com/sforum-apps" },
          langs: {
            "zh-CN": {
              name: "Markdown Plus",
              description: "CommonMark + GFM 渲染，带表格、任务列表与代码高亮。",
            },
          },
        },
        publishedAt: new Date("2026-10-22T09:12:00Z"),
        platforms: [LINUX_AMD64, DARWIN_ARM64],
      },
      {
        version: "1.4.0",
        channel: "stable",
        state: "published",
        constraint: ">=1.2.0 <2.0.0",
        capabilities: ["content.render", "host.api"],
        notes: "代码高亮改用内置语法表，不再请求外部资源。",
        publishedAt: new Date("2026-09-30T03:20:00Z"),
        platforms: [LINUX_AMD64],
      },
      {
        version: "1.3.9",
        channel: "stable",
        state: "yanked",
        constraint: ">=1.1.0 <2.0.0",
        capabilities: ["content.render"],
        notes: "脚注编号在嵌套引用里错位。",
        publishedAt: new Date("2026-09-12T11:05:00Z"),
        yankReason: "脚注编号错位，已由 1.4.0 取代",
        platforms: [LINUX_AMD64],
      },
    ],
  },
  {
    extensionId: "sforum.theme-quiet",
    slug: "theme-quiet",
    kind: "theme",
    category: "appearance",
    ownerSub: "dev-2",
    name: "静谧主题",
    summary: "偏阅读的窄栏排版，系统字体优先，不加载外部字体与图标。",
    readme: SEED_README,
    tags: ["theme", "reading"],
    preview: false,
    updatedAt: new Date("2026-10-21T05:18:00Z"),
    versions: [
      {
        version: "2.0.0",
        channel: "stable",
        state: "published",
        constraint: ">=1.3.0 <2.0.0",
        capabilities: [],
        notes: "正文排版重做；移动端断点从 640 收到 600。",
        manifest: {
          description: "偏阅读的窄栏排版，系统字体优先。",
          url: "https://github.com/sforum-apps/theme-quiet",
          author: { name: "SForum Apps" },
        },
        publishedAt: new Date("2026-10-21T05:10:00Z"),
        platforms: [ANY],
      },
      {
        version: "1.9.0",
        channel: "stable",
        state: "published",
        constraint: ">=1.1.0 <2.0.0",
        capabilities: [],
        notes: "修正引用块左侧留白。",
        publishedAt: new Date("2026-09-18T02:44:00Z"),
        platforms: [ANY],
      },
    ],
  },
  {
    extensionId: "sforum.search-site",
    slug: "search-site",
    kind: "plugin",
    category: "integration",
    ownerSub: "dev-1",
    name: "站内搜索",
    summary: "主题、回复与用户放进同一个检索面，索引落在扩展自己的 schema。",
    readme: SEED_README,
    tags: ["search", "index"],
    preview: false,
    updatedAt: new Date("2026-10-20T06:02:00Z"),
    versions: [
      {
        version: "3.1.0",
        channel: "stable",
        state: "published",
        constraint: ">=1.4.0 <2.0.0",
        capabilities: ["host.api", "content.search", "settings.own"],
        notes: "查询语法支持字段前缀；高亮片段长度可配。",
        publishedAt: new Date("2026-10-20T05:55:00Z"),
        platforms: [LINUX_AMD64, LINUX_ARM64],
      },
      {
        version: "3.0.0",
        channel: "stable",
        state: "published",
        constraint: ">=1.3.0 <2.0.0",
        capabilities: ["host.api", "content.search"],
        notes: "索引重建任务改成可中断的分页作业。",
        publishedAt: new Date("2026-09-25T08:30:00Z"),
        platforms: [LINUX_AMD64],
      },
    ],
  },
];

function releaseTag(slug: string, version: string) {
  return `${slug}-v${version}`;
}

let releaseId = 900_000;
let upstreamAssetId = 7_000_000;

function nextReleaseId() {
  releaseId += 1;
  return releaseId;
}

function nextUpstreamAssetId() {
  upstreamAssetId += 1;
  return upstreamAssetId;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const db = getDb();
const summary = {
  products: 0,
  versions: 0,
  releaseAssets: 0,
  assets: 0,
  files: 0,
};

for (const category of new Set(PRODUCTS.map((product) => product.category))) {
  if (!isCategoryKey(category)) {
    throw new Error(`seed:dev 的分类 ${category} 不在 taxonomy 里`);
  }
}

// Issuer: env no longer seeds one (`STORE_BOOTSTRAP_ISSUER` is gone), so the dev seed writes
// the row the local fake provider expects. In production this row comes from the admin
// console's OAuth2 page.
const seedConfig = getConfig();
const issuerSecret = encryptSecret("dev-secret", seedConfig.keyring);
await db
  .insert(oauthIssuers)
  .values({
    issuerKey: "official",
    displayName: "官方论坛",
    baseUrl: "http://127.0.0.1:4010",
    clientId: "store-client",
    clientSecretCiphertext: issuerSecret,
    clientSecretKid: issuerSecret.split(".")[1] ?? "dev1",
    scopes: ["profile", "avatar"],
    status: "active",
  })
  .onConflictDoNothing();

// Accounts: one issuer, two identities. `sub` is the provider's subject only — the
// account key is (issuer_key, sub), so it must NOT repeat the issuer key.
//
// The subs are `dev-*` on purpose. Real forum subjects are numeric (`1`, `2`, ...), and a
// seed that reused one of them handed the demo products to whoever logged in first: the
// login upserts on (issuer_key, sub), so it matched the seeded row and inherited its
// ownership. A non-numeric subject keeps demo data unreachable from a real account.
const accountIds = new Map<string, string>();
for (const [sub, username, displayName] of [
  ["dev-1", "sforum", "SForum 官方"],
  ["dev-2", "lin", "林"],
] as const) {
  const [row] = await db
    .insert(accounts)
    .values({ issuerKey: "official", sub, username, displayName })
    .onConflictDoUpdate({
      target: [accounts.issuerKey, accounts.sub],
      set: { username, displayName, updatedAt: new Date() },
    })
    .returning({ id: accounts.id });
  accountIds.set(sub, row!.id);
}

// One installation + one repo. The repo hosts three extension ZIPs (one tag
// per release), which is the multi-extension case AGENTS describes.
await db
  .insert(githubInstallations)
  .values({
    installationId: INSTALLATION_ID,
    accountId: accountIds.get("dev-1")!,
    accountLogin: "sforum",
    status: "active",
  })
  .onConflictDoUpdate({
    target: githubInstallations.installationId,
    set: { accountLogin: "sforum", status: "active", updatedAt: new Date() },
  });

await db
  .insert(githubRepos)
  .values({
    repoId: REPO_ID,
    installationId: INSTALLATION_ID,
    fullName: "sforum/markdown-plus",
    private: false,
    archived: false,
    defaultBranch: "main",
    upstreamState: "connected",
    checkedAt: new Date("2026-10-24T00:10:00Z"),
  })
  .onConflictDoUpdate({
    target: githubRepos.repoId,
    set: {
      fullName: "sforum/markdown-plus",
      upstreamState: "connected",
      checkedAt: new Date("2026-10-24T00:10:00Z"),
      updatedAt: new Date(),
    },
  });

// One real PNG in the content-addressed store: the product mark, standing in for a
// GitHub social preview (which the seed cannot fetch without a GitHub App).
const previewBytes = iconPng();
const preview = storePng(previewBytes);

/**
 * `assets.sha256` is unique, so the insert itself is the upsert key: the same
 * bytes always resolve to the same row and never fan out duplicates.
 */
async function upsertAsset(
  bytes: Buffer,
  stored: StoredAsset,
  width: number,
  height: number,
): Promise<string> {
  const values = {
    sha256: stored.sha256,
    mime: "image/png",
    width,
    height,
    bytes: bytes.byteLength,
    storageKey: stored.storageKey,
  };
  const [row] = await db
    .insert(assets)
    .values(values)
    .onConflictDoUpdate({ target: assets.sha256, set: values })
    .returning({ id: assets.id });
  if (stored.written) summary.files += 1;
  summary.assets += 1;
  return row!.id;
}

const previewAssetId = await upsertAsset(previewBytes, preview, 256, 256);
const previewSha256 = createHash("sha256").update(previewBytes).digest("hex");

for (const seed of PRODUCTS) {
  // What an approval would have snapshotted: the union of every seeded version's
  // declared capabilities.
  const reviewedCapabilities = Array.from(
    new Set(seed.versions.flatMap((version) => version.capabilities)),
  );
  const [product] = await db
    .insert(products)
    .values({
      extensionId: seed.extensionId,
      name: seed.name,
      kind: seed.kind,
      slug: seed.slug,
      ownerAccountId: accountIds.get(seed.ownerSub)!,
      repoId: REPO_ID,
      status: "published",
      category: seed.category,
      tags: seed.tags,
      previewAssetId: seed.preview ? previewAssetId : null,
      previewSha256: seed.preview ? previewSha256 : null,
      previewSource: seed.preview ? ("social_preview" as const) : null,
      previewFetchedAt: seed.preview ? PUBLISHED : null,
      defaultLocale: "zh-CN",
      // Seeded products stand in for moderator-approved ones: the review snapshot is what
      // lets a later release auto-publish instead of landing in the re-review queue.
      nameAtReview: seed.name,
      repoIdReviewed: REPO_ID,
      capabilitiesReviewed: reviewedCapabilities,
      publishedAt: seed.updatedAt,
      updatedAt: seed.updatedAt,
    })
    .onConflictDoUpdate({
      target: products.extensionId,
      set: {
        name: seed.name,
        kind: seed.kind,
        slug: seed.slug,
        ownerAccountId: accountIds.get(seed.ownerSub)!,
        repoId: REPO_ID,
        status: "published",
        category: seed.category,
        tags: seed.tags,
        previewAssetId: seed.preview ? previewAssetId : null,
        previewSha256: seed.preview ? previewSha256 : null,
        previewSource: seed.preview ? ("social_preview" as const) : null,
        previewFetchedAt: seed.preview ? PUBLISHED : null,
        defaultLocale: "zh-CN",
        nameAtReview: seed.name,
        repoIdReviewed: REPO_ID,
        capabilitiesReviewed: reviewedCapabilities,
        publishedAt: seed.updatedAt,
        updatedAt: seed.updatedAt,
      },
    })
    .returning({ id: products.id });

  const productId = product!.id;
  summary.products += 1;

  await db
    .insert(productTranslations)
    .values({
      productId,
      locale: "zh-CN",
      name: seed.name,
      summary: seed.summary,
    })
    .onConflictDoUpdate({
      target: [productTranslations.productId, productTranslations.locale],
      set: {
        name: seed.name,
        summary: seed.summary,
        updatedAt: new Date(),
      },
    });

  // The README cache, rendered by the same function the sync worker uses.
  await db
    .insert(productReadmes)
    .values({
      productId,
      repoId: REPO_ID,
      ref: "HEAD",
      path: "README.md",
      blobSha: createHash("sha1").update(seed.readme).digest("hex"),
      markdown: seed.readme,
      html: renderReadme({
        source: seed.readme,
        repoFullName: "sforum/markdown-plus",
        path: "README.md",
        format: "markdown",
      }),
      byteSize: Buffer.byteLength(seed.readme, "utf8"),
      fetchedAt: PUBLISHED,
      fetchError: null,
    })
    .onConflictDoUpdate({
      target: productReadmes.productId,
      set: {
        repoId: REPO_ID,
        blobSha: createHash("sha1").update(seed.readme).digest("hex"),
        markdown: seed.readme,
        html: renderReadme({
          source: seed.readme,
          repoFullName: "sforum/markdown-plus",
          path: "README.md",
          format: "markdown",
        }),
        byteSize: Buffer.byteLength(seed.readme, "utf8"),
        fetchedAt: PUBLISHED,
        fetchError: null,
      },
    });

  for (const version of seed.versions) {
    const publishedAt = version.publishedAt;
    const [release] = await db
      .insert(repoReleases)
      .values({
        repoId: REPO_ID,
        githubReleaseId: nextReleaseId(),
        tag: releaseTag(seed.slug, version.version),
        targetCommitish: "main",
        isPrerelease: version.channel === "beta",
        body: version.notes,
        syncState: "synced",
        lastSyncedAt: PUBLISHED,
      })
      .onConflictDoUpdate({
        target: [repoReleases.repoId, repoReleases.tag],
        set: {
          body: version.notes,
          isPrerelease: version.channel === "beta",
          syncState: "synced",
          lastSyncedAt: PUBLISHED,
          updatedAt: new Date(),
        },
      })
      .returning({ id: repoReleases.id });

    const [row] = await db
      .insert(releaseVersions)
      .values({
        productId,
        repoReleaseId: release!.id,
        version: version.version,
        channel: version.channel,
        state: version.state,
        sforumVersionConstraint: version.constraint,
        capabilities: version.capabilities,
        manifestDescription: version.manifest?.description ?? seed.summary,
        manifestUrl:
          version.manifest?.url ?? `https://github.com/sforum-apps/${seed.slug}`,
        manifestAuthorName: version.manifest?.author?.name ?? "SForum Apps",
        manifestAuthorUrl:
          version.manifest?.author?.url ?? "https://github.com/sforum-apps",
        manifestLangs: version.manifest?.langs ?? {},
        notesMd: version.notes,
        publishedAt,
        yankedAt: version.state === "yanked" ? new Date("2026-09-20T00:00:00Z") : null,
        yankReason: version.yankReason ?? null,
        updatedAt: publishedAt,
      })
      .onConflictDoUpdate({
        target: [releaseVersions.productId, releaseVersions.version],
        set: {
          repoReleaseId: release!.id,
          channel: version.channel,
          state: version.state,
          sforumVersionConstraint: version.constraint,
          capabilities: version.capabilities,
          manifestDescription: version.manifest?.description ?? seed.summary,
          manifestUrl:
            version.manifest?.url ?? `https://github.com/sforum-apps/${seed.slug}`,
          manifestAuthorName: version.manifest?.author?.name ?? "SForum Apps",
          manifestAuthorUrl:
            version.manifest?.author?.url ?? "https://github.com/sforum-apps",
          manifestLangs: version.manifest?.langs ?? {},
          notesMd: version.notes,
          publishedAt,
          yankedAt: version.state === "yanked" ? new Date("2026-09-20T00:00:00Z") : null,
          yankReason: version.yankReason ?? null,
          updatedAt: publishedAt,
        },
      })
      .returning({ id: releaseVersions.id });

    summary.versions += 1;

    for (const platform of version.platforms) {
      const suffix = platform.os === "any" ? "any" : `${platform.os}-${platform.arch}`;
      await db
        .insert(releaseAssets)
        .values({
          releaseVersionId: row!.id,
          os: platform.os,
          arch: platform.arch,
          filename: `${seed.slug}-${version.version}-${suffix}.zip`,
          size: 1_600_000 + ((version.version.length + platform.arch.length) % 9) * 137_000,
          sha256: sha256Hex(`${seed.slug}:${version.version}:${platform.os}:${platform.arch}`),
          upstreamAssetId: nextUpstreamAssetId(),
          detectionSource: platform.detection,
        })
        .onConflictDoUpdate({
          target: [
            releaseAssets.releaseVersionId,
            releaseAssets.os,
            releaseAssets.arch,
          ],
          set: {
            filename: `${seed.slug}-${version.version}-${suffix}.zip`,
            sha256: sha256Hex(
              `${seed.slug}:${version.version}:${platform.os}:${platform.arch}`,
            ),
            detectionSource: platform.detection,
          },
        });
      summary.releaseAssets += 1;
    }
  }

  const latest = await recomputeProductLatestVersions(db, productId);
  console.log(
    `  ${seed.slug.padEnd(16)} ${seed.kind.padEnd(6)} latest stable=${latest.stable ?? "—"}`,
  );
}

const total = await db.select({ id: products.id }).from(products);
const totalAssets = await db.select({ id: assets.id }).from(assets);

console.log("");
console.log(`asset root      ${assetRoot()}`);
console.log(`preview         ${preview.storageKey} (${previewBytes.byteLength} B)`);
console.log(
  `products        ${summary.products} written (${total.length} rows in table)`,
);
console.log(`versions        ${summary.versions} written`);
console.log(`release assets  ${summary.releaseAssets} written`);
console.log(
  `image assets    ${summary.assets} upserted, ${summary.files} file(s) new (${totalAssets.length} rows in table)`,
);

await closeDb();
