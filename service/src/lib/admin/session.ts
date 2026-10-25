import { and, eq, gt, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { adminAccounts, adminSessions } from "@/db/schema";
import { randomToken, sha256Hex } from "@/lib/crypto";

export type AdminAccount = typeof adminAccounts.$inferSelect;

export type CurrentAdminSession = {
  admin: AdminAccount;
  sessionId: string;
  expiresAt: Date;
};

export type CreatedAdminSession = {
  token: string;
  expiresAt: Date;
};

export async function createAdminSession(
  db: Db,
  adminId: string,
  input: { ttlSeconds: number; userAgent?: string | null; ip?: string | null },
): Promise<CreatedAdminSession> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  await db.insert(adminSessions).values({
    adminId,
    tokenHash: sha256Hex(token),
    expiresAt,
    userAgent: input.userAgent ?? null,
    ip: input.ip ?? null,
  });
  return { token, expiresAt };
}

/**
 * Resolves a cookie token to an active administrator. An expired session, a disabled account
 * and an unknown token all read as "no session" — the caller never learns which.
 */
export async function findAdminSession(
  db: Db,
  token: string,
): Promise<CurrentAdminSession | null> {
  const [row] = await db
    .select({ session: adminSessions, admin: adminAccounts })
    .from(adminSessions)
    .innerJoin(adminAccounts, eq(adminSessions.adminId, adminAccounts.id))
    .where(
      and(
        eq(adminSessions.tokenHash, sha256Hex(token)),
        gt(adminSessions.expiresAt, new Date()),
        eq(adminAccounts.status, "active"),
      ),
    )
    .limit(1);

  if (!row) return null;
  return {
    admin: row.admin,
    sessionId: row.session.id,
    expiresAt: row.session.expiresAt,
  };
}

export async function deleteAdminSessionByToken(db: Db, token: string): Promise<void> {
  await db.delete(adminSessions).where(eq(adminSessions.tokenHash, sha256Hex(token)));
}

export async function deleteAdminSessionsForAdmin(
  db: Db,
  adminId: string,
): Promise<number> {
  const rows = await db
    .delete(adminSessions)
    .where(eq(adminSessions.adminId, adminId))
    .returning({ id: adminSessions.id });
  return rows.length;
}

export async function countAdminSessions(db: Db, adminId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(adminSessions)
    .where(
      and(eq(adminSessions.adminId, adminId), gt(adminSessions.expiresAt, new Date())),
    );
  return row?.count ?? 0;
}

/** Housekeeping: drop sessions that can never authenticate again. */
export async function purgeExpiredAdminSessions(db: Db): Promise<number> {
  const rows = await db
    .delete(adminSessions)
    .where(sql`${adminSessions.expiresAt} <= now()`)
    .returning({ id: adminSessions.id });
  return rows.length;
}
