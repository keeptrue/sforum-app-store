import { and, eq, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { adminAccounts } from "@/db/schema";
import { AdminError } from "@/lib/admin/errors";
import { hashPassword, validatePassword, verifyPassword } from "@/lib/admin/password";
import { createAdminSession, type CreatedAdminSession } from "@/lib/admin/session";
import type { StoreConfig } from "@/lib/config";
import { recordAudit } from "@/lib/moderation/events";

/** 5 failures inside the window lock the account for 15 minutes. */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_SECONDS = 15 * 60;

export type LoginResult = CreatedAdminSession & {
  adminId: string;
  username: string;
  mustChangePassword: boolean;
};

/**
 * Password login for a store-local administrator.
 *
 * Every branch that ends in a refusal writes an audit row; the caller never learns whether
 * the username exists, is disabled, or is locked (same shape, same timing class).
 */
export async function loginAdmin(
  db: Db,
  config: StoreConfig,
  input: {
    username: string;
    password: string;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<LoginResult> {
  const username = input.username.trim();
  const [row] = await db
    .select()
    .from(adminAccounts)
    .where(sql`lower(${adminAccounts.username}) = lower(${username})`)
    .limit(1);

  if (!row) {
    await audit(db, "admin.login.failed", null, { reason: "unknown_account" }, input.ip);
    throw new AdminError("invalid_credentials", 401, "用户名或密码不正确");
  }

  if (row.status !== "active") {
    await audit(db, "admin.login.failed", row.id, { reason: "disabled" }, input.ip);
    throw new AdminError("invalid_credentials", 401, "用户名或密码不正确");
  }

  if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
    const seconds = Math.ceil((row.lockedUntil.getTime() - Date.now()) / 1000);
    await audit(db, "admin.login.failed", row.id, { reason: "locked" }, input.ip);
    throw new AdminError(
      "account_locked",
      429,
      `账号已锁定，请 ${Math.ceil(seconds / 60)} 分钟后再试`,
    );
  }

  if (!verifyPassword(input.password, row.passwordHash)) {
    const attempts = row.failedAttempts + 1;
    const locked = attempts >= MAX_FAILED_ATTEMPTS;
    await db
      .update(adminAccounts)
      .set({
        failedAttempts: locked ? 0 : attempts,
        lockedUntil: locked ? new Date(Date.now() + LOCKOUT_SECONDS * 1000) : null,
        updatedAt: new Date(),
      })
      .where(eq(adminAccounts.id, row.id));

    await audit(
      db,
      "admin.login.failed",
      row.id,
      { reason: "bad_password", attempts, locked },
      input.ip,
    );
    if (locked) {
      throw new AdminError(
        "account_locked",
        429,
        `连续 ${MAX_FAILED_ATTEMPTS} 次失败，账号锁定 15 分钟`,
      );
    }
    throw new AdminError("invalid_credentials", 401, "用户名或密码不正确");
  }

  await db
    .update(adminAccounts)
    .set({
      failedAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(adminAccounts.id, row.id));

  const session = await createAdminSession(db, row.id, {
    ttlSeconds: config.adminSessionTtlSeconds,
    userAgent: input.userAgent,
    ip: input.ip,
  });

  await audit(db, "admin.login.succeeded", row.id, {}, input.ip);

  return {
    ...session,
    adminId: row.id,
    username: row.username,
    mustChangePassword: row.mustChangePassword,
  };
}

export async function changeAdminPassword(
  db: Db,
  input: {
    adminId: string;
    currentPassword: string;
    newPassword: string;
    ip?: string | null;
  },
): Promise<void> {
  const [row] = await db
    .select()
    .from(adminAccounts)
    .where(eq(adminAccounts.id, input.adminId))
    .limit(1);
  if (!row) throw new AdminError("not_found", 404, "管理员不存在");

  if (!verifyPassword(input.currentPassword, row.passwordHash)) {
    await audit(db, "admin.password.change_failed", row.id, {}, input.ip);
    throw new AdminError("invalid_credentials", 401, "当前密码不正确");
  }

  const problem = validatePassword(input.newPassword, row.username);
  if (problem) throw new AdminError("invalid_password", 400, problem);
  if (input.newPassword === input.currentPassword) {
    throw new AdminError("password_unchanged", 400, "新密码不能与当前密码相同");
  }

  await db
    .update(adminAccounts)
    .set({
      passwordHash: hashPassword(input.newPassword),
      mustChangePassword: false,
      updatedAt: new Date(),
    })
    .where(eq(adminAccounts.id, row.id));

  await audit(db, "admin.password.changed", row.id, {}, input.ip);
}

/** Set by an administrator for someone else; forces a change at next login. */
export async function resetAdminPassword(
  db: Db,
  input: {
    adminId: string;
    newPassword: string;
    actorAdminId: string;
    ip?: string | null;
  },
): Promise<void> {
  const [row] = await db
    .select()
    .from(adminAccounts)
    .where(eq(adminAccounts.id, input.adminId))
    .limit(1);
  if (!row) throw new AdminError("not_found", 404, "管理员不存在");

  const problem = validatePassword(input.newPassword, row.username);
  if (problem) throw new AdminError("invalid_password", 400, problem);

  await db
    .update(adminAccounts)
    .set({
      passwordHash: hashPassword(input.newPassword),
      mustChangePassword: true,
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(adminAccounts.id, row.id));

  await audit(
    db,
    "admin.password.reset",
    row.id,
    { byAdmin: input.actorAdminId },
    input.ip,
    input.actorAdminId,
  );
}

async function audit(
  db: Db,
  action: string,
  adminId: string | null,
  details: Record<string, unknown>,
  ip?: string | null,
  actorAdminId?: string,
): Promise<void> {
  try {
    await recordAudit(db, {
      actorAdminId: actorAdminId ?? null,
      action,
      targetType: "admin",
      targetId: adminId,
      details,
      ip: ip ?? null,
    });
  } catch (error) {
    // Audit is evidence, not a gate: a write failure must not turn a login into an error.
    console.warn("[admin] failed to write audit", {
      action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Housekeeping helper used by the accounts page: active admins excluding one id. */
export async function countActiveAdminsExcluding(
  db: Db,
  adminId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(adminAccounts)
    .where(and(eq(adminAccounts.status, "active"), sql`${adminAccounts.id} <> ${adminId}`));
  return row?.count ?? 0;
}
