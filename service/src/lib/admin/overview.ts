import { desc, eq } from "drizzle-orm";

import { getPool, type Db } from "@/db/client";
import { adminAccounts, oauthIssuers } from "@/db/schema";

export type OverviewCounts = {
  admins: number;
  adminsDisabled: number;
  forumAccounts: number;
  moderators: number;
  products: number;
  published: number;
  pendingProducts: number;
  versions: number;
  pendingVersions: number;
  issuers: number;
  activeIssuers: number;
  assets: number;
};

export type RecentAdminLogin = {
  username: string;
  lastLoginAt: Date | null;
};

/**
 * Counts for the overview. One aggregate query rather than a dozen round trips — and rather
 * than loading rows, so the page stays flat as the catalog grows.
 */
const COUNTS_SQL = `
  select
    (select count(*)::int from admin_accounts) as admins,
    (select count(*)::int from admin_accounts where status = 'disabled') as admins_disabled,
    (select count(*)::int from accounts) as forum_accounts,
    (select count(*)::int from store_roles where role = 'moderator') as moderators,
    (select count(*)::int from products) as products,
    (select count(*)::int from products where status = 'published') as published,
    (select count(*)::int from products where status = 'pending_review') as pending_products,
    (select count(*)::int from release_versions) as versions,
    (select count(*)::int from release_versions
       where state in ('candidate', 'pending_review')) as pending_versions,
    (select count(*)::int from oauth_issuers) as issuers,
    (select count(*)::int from oauth_issuers where status = 'active') as active_issuers,
    (select count(*)::int from assets) as assets
`;

export async function loadOverview(db: Db): Promise<{
  counts: OverviewCounts;
  recentLogins: RecentAdminLogin[];
  issuers: { issuerKey: string; displayName: string; status: string }[];
}> {
  const { rows } = await getPool().query<{
    admins: number;
    admins_disabled: number;
    forum_accounts: number;
    moderators: number;
    products: number;
    published: number;
    pending_products: number;
    versions: number;
    pending_versions: number;
    issuers: number;
    active_issuers: number;
    assets: number;
  }>(COUNTS_SQL);
  const row = rows[0];

  const recentLogins = await db
    .select({
      username: adminAccounts.username,
      lastLoginAt: adminAccounts.lastLoginAt,
    })
    .from(adminAccounts)
    .where(eq(adminAccounts.status, "active"))
    .orderBy(desc(adminAccounts.lastLoginAt))
    .limit(5);

  const issuers = await db
    .select({
      issuerKey: oauthIssuers.issuerKey,
      displayName: oauthIssuers.displayName,
      status: oauthIssuers.status,
    })
    .from(oauthIssuers)
    .orderBy(oauthIssuers.displayName);

  const counts: OverviewCounts = {
    admins: row?.admins ?? 0,
    adminsDisabled: row?.admins_disabled ?? 0,
    forumAccounts: row?.forum_accounts ?? 0,
    moderators: row?.moderators ?? 0,
    products: row?.products ?? 0,
    published: row?.published ?? 0,
    pendingProducts: row?.pending_products ?? 0,
    versions: row?.versions ?? 0,
    pendingVersions: row?.pending_versions ?? 0,
    issuers: row?.issuers ?? 0,
    activeIssuers: row?.active_issuers ?? 0,
    assets: row?.assets ?? 0,
  };

  return { counts, recentLogins, issuers };
}
