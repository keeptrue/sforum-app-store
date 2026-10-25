/**
 * `backup:legacy-media` — dump the media and long-form copy that migration `0011` deletes.
 *
 * The move to GitHub-only product identity drops three things on purpose:
 * `products.icon_asset_id`, the whole `product_screenshots` table, and
 * `product_translations.description_md`. The `assets` rows and their files are kept, so a
 * dump of the *references* is enough to rebuild a product page by hand if the decision is
 * ever revisited.
 *
 * Run this BEFORE `bun run db:migrate`:
 *
 *   bun run backup:legacy-media
 *   bun run db:migrate
 *
 * The output path is printed on success. Nothing is deleted here; the script only reads.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";

import { closeDb, getDb } from "@/db/client";
import { getConfig } from "@/lib/config";

type Row = Record<string, unknown>;

type LegacyProduct = {
  id: string;
  extensionId: string;
  slug: string;
  name: string;
  iconAssetId: string | null;
  iconSha256: string | null;
  iconStorageKey: string | null;
};

type LegacyScreenshot = {
  productId: string;
  assetId: string;
  position: number;
  sha256: string | null;
  storageKey: string | null;
};

type LegacyTranslation = {
  productId: string;
  locale: string;
  descriptionMd: string | null;
};

type LegacyAsset = {
  sha256: string;
  mime: string;
  bytes: number;
  storageKey: string;
  fileExists: boolean;
};

function value(row: Row, key: string): unknown {
  return row[key];
}

function asString(row: Row, key: string): string {
  const found = value(row, key);
  return typeof found === "string" ? found : String(found ?? "");
}

function asNullableString(row: Row, key: string): string | null {
  const found = value(row, key);
  return typeof found === "string" && found.length > 0 ? found : null;
}

function asNumber(row: Row, key: string): number {
  const found = value(row, key);
  return typeof found === "number" ? found : Number(found ?? 0);
}

async function hasColumn(table: string, column: string): Promise<boolean> {
  const db = getDb();
  const result = await db.execute<Row>(sql`
    select 1 as present
    from information_schema.columns
    where table_schema = 'public'
      and table_name = ${table}
      and column_name = ${column}
    limit 1
  `);
  return result.rows.length > 0;
}

async function hasTable(table: string): Promise<boolean> {
  const db = getDb();
  const result = await db.execute<Row>(sql`
    select 1 as present
    from information_schema.tables
    where table_schema = 'public' and table_name = ${table}
    limit 1
  `);
  return result.rows.length > 0;
}

async function main(): Promise<void> {
  const db = getDb();
  const assetDir = resolve(getConfig().assetDir);

  const iconColumn = await hasColumn("products", "icon_asset_id");
  const screenshotTable = await hasTable("product_screenshots");
  const descriptionColumn = await hasColumn("product_translations", "description_md");

  if (!iconColumn && !screenshotTable && !descriptionColumn) {
    console.error(
      "没有可备份的旧媒体：icon_asset_id / product_screenshots / description_md 都不存在。\n" +
        "迁移 0011 可能已经跑过。",
    );
    process.exitCode = 1;
    return;
  }

  const products: LegacyProduct[] = iconColumn
    ? (
        await db.execute<Row>(sql`
          select p.id, p.extension_id, p.slug, p.name, p.icon_asset_id,
                 a.sha256 as icon_sha256, a.storage_key as icon_storage_key
          from products p
          left join assets a on a.id = p.icon_asset_id
          where p.icon_asset_id is not null
          order by p.created_at
        `)
      ).rows.map((row) => ({
        id: asString(row, "id"),
        extensionId: asString(row, "extension_id"),
        slug: asString(row, "slug"),
        name: asString(row, "name"),
        iconAssetId: asNullableString(row, "icon_asset_id"),
        iconSha256: asNullableString(row, "icon_sha256"),
        iconStorageKey: asNullableString(row, "icon_storage_key"),
      }))
    : [];

  const screenshots: LegacyScreenshot[] = screenshotTable
    ? (
        await db.execute<Row>(sql`
          select s.product_id, s.asset_id, s.position,
                 a.sha256, a.storage_key
          from product_screenshots s
          left join assets a on a.id = s.asset_id
          order by s.product_id, s.position
        `)
      ).rows.map((row) => ({
        productId: asString(row, "product_id"),
        assetId: asString(row, "asset_id"),
        position: asNumber(row, "position"),
        sha256: asNullableString(row, "sha256"),
        storageKey: asNullableString(row, "storage_key"),
      }))
    : [];

  const translations: LegacyTranslation[] = descriptionColumn
    ? (
        await db.execute<Row>(sql`
          select product_id, locale, description_md
          from product_translations
          where description_md is not null and description_md <> ''
          order by product_id, locale
        `)
      ).rows.map((row) => ({
        productId: asString(row, "product_id"),
        locale: asString(row, "locale"),
        descriptionMd: asNullableString(row, "description_md"),
      }))
    : [];

  const digests = new Set<string>();
  for (const item of products) if (item.iconSha256) digests.add(item.iconSha256);
  for (const item of screenshots) if (item.sha256) digests.add(item.sha256);

  const assets: LegacyAsset[] = [];
  for (const sha256 of digests) {
    const result = await db.execute<Row>(sql`
      select sha256, mime, bytes, storage_key from assets where sha256 = ${sha256} limit 1
    `);
    const row = result.rows[0];
    if (!row) continue;
    const storageKey = asString(row, "storage_key");
    assets.push({
      sha256,
      mime: asString(row, "mime"),
      bytes: asNumber(row, "bytes"),
      storageKey,
      fileExists: existsSync(resolve(assetDir, storageKey)),
    });
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    note: "Migration 0011 deletes these references. Assets rows and files are kept.",
    assetDir,
    products,
    screenshots,
    translations,
    assets,
  };

  const outDir = resolve(process.cwd(), "..", "tmp");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = resolve(outDir, `legacy-media-${stamp}.json`);
  writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(`备份完成：${outFile}`);
  console.log(
    `  产品图标 ${products.length} 个 · 截图 ${screenshots.length} 张 · 介绍 ${translations.length} 条 · 资产 ${assets.length} 个`,
  );
  const missing = assets.filter((asset) => !asset.fileExists);
  if (missing.length > 0) {
    console.warn(`  注意：${missing.length} 个资产文件已不在 ${assetDir}`);
  }
}

await main();
await closeDb();
