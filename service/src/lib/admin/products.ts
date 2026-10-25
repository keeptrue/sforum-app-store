import { and, eq, ilike, or, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { accounts, products } from "@/db/schema";
import { delistProductAsModerator } from "@/lib/moderation/service";
import { yankReleaseVersion } from "@/lib/products/service";
import type { ProductStatus } from "@/lib/products/types";

/**
 * Cross-owner product administration.
 *
 * The read side is a new query (the dashboard list is owner-scoped by design). The write side
 * deliberately reuses the moderation domain services instead of re-implementing the state
 * transitions — one implementation per transition, with an admin actor recorded in the audit
 * trail.
 */

export type AdminProductRow = {
  id: string;
  slug: string;
  name: string;
  extensionId: string;
  kind: "plugin" | "theme";
  status: ProductStatus;
  ownerName: string | null;
  ownerIssuer: string | null;
  versionCount: number;
  publishedVersions: number;
  pendingVersions: number;
  updatedAt: Date;
};

export type AdminProductQuery = {
  q?: string;
  status?: ProductStatus | "all";
  limit?: number;
  offset?: number;
};

export async function listProductsForAdmin(
  db: Db,
  input: AdminProductQuery = {},
): Promise<{ rows: AdminProductRow[]; total: number }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);
  const q = input.q?.trim();

  const filters = [];
  if (q) {
    filters.push(
      or(
        ilike(products.name, `%${q}%`),
        ilike(products.slug, `%${q}%`),
        ilike(products.extensionId, `%${q}%`),
      ),
    );
  }
  if (input.status && input.status !== "all") {
    filters.push(eq(products.status, input.status));
  }
  const where = filters.length ? and(...filters) : undefined;

  const rows = await db
    .select({
      id: products.id,
      slug: products.slug,
      name: products.name,
      extensionId: products.extensionId,
      kind: products.kind,
      status: products.status,
      ownerName: accounts.displayName,
      ownerIssuer: accounts.issuerKey,
      updatedAt: products.updatedAt,
      versionCount: sql<number>`(
        select count(*)::int from release_versions
        where release_versions.product_id = products.id
      )`,
      publishedVersions: sql<number>`(
        select count(*)::int from release_versions
        where release_versions.product_id = products.id and release_versions.state = 'published'
      )`,
      pendingVersions: sql<number>`(
        select count(*)::int from release_versions
        where release_versions.product_id = products.id
          and release_versions.state in ('candidate', 'pending_review')
      )`,
    })
    .from(products)
    .leftJoin(accounts, eq(products.ownerAccountId, accounts.id))
    .where(where)
    .orderBy(sql`${products.updatedAt} desc`)
    .limit(limit)
    .offset(offset);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(products)
    .where(where);

  return { rows, total: countRow?.count ?? 0 };
}

export async function forceDelistProduct(
  db: Db,
  input: { productId: string; reason: string; actorAdminId: string; ip?: string | null },
): Promise<void> {
  await delistProductAsModerator(db, {
    productId: input.productId,
    reason: input.reason,
    actorAdminId: input.actorAdminId,
    ip: input.ip ?? null,
  });
}

export async function forceYankVersion(
  db: Db,
  input: { versionId: string; reason: string; actorAdminId: string; ip?: string | null },
): Promise<void> {
  await yankReleaseVersion(db, {
    versionId: input.versionId,
    reason: input.reason,
    actorAdminId: input.actorAdminId,
    ip: input.ip ?? null,
  });
}
