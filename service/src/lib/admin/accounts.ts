import { and, eq, ilike, or, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { accounts, adminAccounts, adminSessions, sessions, storeRoles } from "@/db/schema";
import { AdminError } from "@/lib/admin/errors";
import { hashPassword, validatePassword } from "@/lib/admin/password";
import { countAdminSessions } from "@/lib/admin/session";
import { recordAudit } from "@/lib/moderation/events";

/**
 * Account administration: the store's own administrators (local password identity) and the
 * forum accounts that can be given the `moderator` role.
 *
 * These are two different populations and the page shows them in two blocks. `admin` is no
 * longer a `store_roles` value that grants anything — see the 2026-10-25 decision record.
 */

export type AdminRow = {
  id: string;
  username: string;
  displayName: string | null;
  status: "active" | "disabled";
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  lockedUntil: Date | null;
  sessionCount: number;
  createdAt: Date;
};

export async function listAdmins(db: Db): Promise<AdminRow[]> {
  const rows = await db
    .select({
      id: adminAccounts.id,
      username: adminAccounts.username,
      displayName: adminAccounts.displayName,
      status: adminAccounts.status,
      mustChangePassword: adminAccounts.mustChangePassword,
      lastLoginAt: adminAccounts.lastLoginAt,
      lockedUntil: adminAccounts.lockedUntil,
      createdAt: adminAccounts.createdAt,
      sessionCount: sql<number>`(
        select count(*)::int from admin_sessions
        where admin_sessions.admin_id = admin_accounts.id
          and admin_sessions.expires_at > now()
      )`,
    })
    .from(adminAccounts)
    .orderBy(adminAccounts.createdAt);

  return rows;
}

export type ForumAccountRow = {
  id: string;
  issuerKey: string;
  sub: string;
  username: string | null;
  displayName: string | null;
  email: string | null;
  isModerator: boolean;
  legacyAdmin: boolean;
  sessionCount: number;
  createdAt: Date;
};

/**
 * Forum accounts, newest first. `legacyAdmin` surfaces rows that still carry the retired
 * `store_roles.role='admin'` grant so the page can say plainly that it no longer applies.
 */
export async function listForumAccounts(
  db: Db,
  input: { query?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: ForumAccountRow[]; total: number }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);
  const query = input.query?.trim();

  const filter = query
    ? or(
        ilike(accounts.username, `%${query}%`),
        ilike(accounts.displayName, `%${query}%`),
        ilike(accounts.email, `%${query}%`),
        ilike(accounts.issuerKey, `%${query}%`),
      )
    : undefined;

  const rows = await db
    .select({
      id: accounts.id,
      issuerKey: accounts.issuerKey,
      sub: accounts.sub,
      username: accounts.username,
      displayName: accounts.displayName,
      email: accounts.email,
      createdAt: accounts.createdAt,
      isModerator: sql<boolean>`exists (
        select 1 from store_roles
        where store_roles.account_id = accounts.id and store_roles.role = 'moderator'
      )`,
      legacyAdmin: sql<boolean>`exists (
        select 1 from store_roles
        where store_roles.account_id = accounts.id and store_roles.role = 'admin'
      )`,
      sessionCount: sql<number>`(
        select count(*)::int from sessions
        where sessions.account_id = accounts.id and sessions.expires_at > now()
      )`,
    })
    .from(accounts)
    .where(filter)
    .orderBy(sql`${accounts.createdAt} desc`)
    .limit(limit)
    .offset(offset);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(accounts)
    .where(filter);

  return { rows, total: countRow?.count ?? 0 };
}

export async function createAdmin(
  db: Db,
  input: {
    username: string;
    password: string;
    displayName?: string | null;
    actorAdminId: string;
    ip?: string | null;
  },
): Promise<{ id: string; username: string }> {
  const username = input.username.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(username)) {
    throw new AdminError(
      "invalid_username",
      400,
      "用户名需为 3-32 位字母、数字、点、下划线或连字符，且以字母或数字开头",
    );
  }
  const problem = validatePassword(input.password, username);
  if (problem) throw new AdminError("invalid_password", 400, problem);

  const [existing] = await db
    .select({ id: adminAccounts.id })
    .from(adminAccounts)
    .where(sql`lower(${adminAccounts.username}) = lower(${username})`)
    .limit(1);
  if (existing) throw new AdminError("username_taken", 409, "这个用户名已被占用");

  const [row] = await db
    .insert(adminAccounts)
    .values({
      username,
      passwordHash: hashPassword(input.password),
      displayName: input.displayName?.trim() || username,
      // A password set by someone else must be replaced before the console opens.
      mustChangePassword: true,
    })
    .returning({ id: adminAccounts.id, username: adminAccounts.username });
  if (!row) throw new AdminError("create_failed", 500);

  await recordAudit(db, {
    actorAdminId: input.actorAdminId,
    action: "admin.account.created",
    targetType: "admin",
    targetId: row.id,
    details: { username: row.username },
    ip: input.ip ?? null,
  });

  return row;
}

/**
 * Enable/disable. Disabling the last active administrator is refused: there is no recovery
 * path from the console once nobody can sign in.
 */
export async function setAdminStatus(
  db: Db,
  input: {
    adminId: string;
    status: "active" | "disabled";
    actorAdminId: string;
    ip?: string | null;
  },
): Promise<void> {
  const [target] = await db
    .select({ id: adminAccounts.id, status: adminAccounts.status })
    .from(adminAccounts)
    .where(eq(adminAccounts.id, input.adminId))
    .limit(1);
  if (!target) throw new AdminError("not_found", 404, "管理员不存在");
  if (target.status === input.status) return;

  if (input.status === "disabled") {
    const [others] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(adminAccounts)
      .where(and(eq(adminAccounts.status, "active"), sql`${adminAccounts.id} <> ${input.adminId}`));
    if ((others?.count ?? 0) === 0) {
      throw new AdminError("last_admin", 409, "这是最后一个启用的管理员，禁用后将无人能登录后台");
    }
  }

  await db
    .update(adminAccounts)
    .set({ status: input.status, updatedAt: new Date() })
    .where(eq(adminAccounts.id, input.adminId));

  if (input.status === "disabled") {
    await db.delete(adminSessions).where(eq(adminSessions.adminId, input.adminId));
  }

  await recordAudit(db, {
    actorAdminId: input.actorAdminId,
    action: input.status === "disabled" ? "admin.account.disabled" : "admin.account.enabled",
    targetType: "admin",
    targetId: input.adminId,
    ip: input.ip ?? null,
  });
}

export async function revokeAdminSessions(
  db: Db,
  input: { adminId: string; actorAdminId: string; ip?: string | null },
): Promise<number> {
  const rows = await db
    .delete(adminSessions)
    .where(eq(adminSessions.adminId, input.adminId))
    .returning({ id: adminSessions.id });

  await recordAudit(db, {
    actorAdminId: input.actorAdminId,
    action: "admin.session.revoked",
    targetType: "session",
    targetId: input.adminId,
    details: { count: rows.length, scope: "admin" },
    ip: input.ip ?? null,
  });
  return rows.length;
}

export async function revokeForumSessions(
  db: Db,
  input: { accountId: string; actorAdminId: string; ip?: string | null },
): Promise<number> {
  const rows = await db
    .delete(sessions)
    .where(eq(sessions.accountId, input.accountId))
    .returning({ id: sessions.id });

  await recordAudit(db, {
    actorAdminId: input.actorAdminId,
    action: "admin.session.revoked",
    targetType: "session",
    targetId: input.accountId,
    details: { count: rows.length, scope: "forum" },
    ip: input.ip ?? null,
  });
  return rows.length;
}

/** Grants or revokes the `moderator` role on a forum account. `admin` is not grantable. */
export async function setModeratorRole(
  db: Db,
  input: {
    accountId: string;
    granted: boolean;
    actorAdminId: string;
    ip?: string | null;
  },
): Promise<void> {
  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, input.accountId))
    .limit(1);
  if (!account) throw new AdminError("not_found", 404, "论坛账号不存在");

  if (input.granted) {
    await db
      .insert(storeRoles)
      .values({ accountId: input.accountId, role: "moderator", grantedBy: input.actorAdminId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(storeRoles)
      .where(and(eq(storeRoles.accountId, input.accountId), eq(storeRoles.role, "moderator")));
  }

  await recordAudit(db, {
    actorAdminId: input.actorAdminId,
    action: input.granted ? "admin.role.granted" : "admin.role.revoked",
    targetType: "account",
    targetId: input.accountId,
    details: { role: "moderator" },
    ip: input.ip ?? null,
  });
}

export async function adminSessionCount(db: Db, adminId: string): Promise<number> {
  return countAdminSessions(db, adminId);
}
