import { createHash, timingSafeEqual } from "node:crypto";

import { sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { adminAccounts } from "@/db/schema";
import { AdminError } from "@/lib/admin/errors";
import { hashPassword, validatePassword } from "@/lib/admin/password";
import type { StoreConfig } from "@/lib/config";
import { recordAudit } from "@/lib/moderation/events";

/**
 * First-administrator registration.
 *
 * The registration route exists only while `admin_accounts` is empty, and only for callers
 * holding `STORE_ADMIN_SETUP_TOKEN`. With the token unset the route is closed rather than
 * open to whoever arrives first — a public URL plus a password form is a takeover window.
 */

/** Advisory lock key: one arbitrary constant, stable across deploys. */
const BOOTSTRAP_LOCK = 0x53544f52; // "STOR"

export async function countAdmins(db: Db): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(adminAccounts);
  return row?.count ?? 0;
}

export async function hasAdmin(db: Db): Promise<boolean> {
  return (await countAdmins(db)) > 0;
}

function tokenMatches(provided: string, expected: string): boolean {
  // Compare digests so the comparison is length-independent and constant time.
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export type RegisterAdminInput = {
  token: string;
  username: string;
  password: string;
  displayName?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export type RegisteredAdmin = {
  id: string;
  username: string;
};

export async function registerFirstAdmin(
  db: Db,
  config: StoreConfig,
  input: RegisterAdminInput,
): Promise<RegisteredAdmin> {
  if (!config.adminSetupToken) {
    throw new AdminError(
      "setup_disabled",
      403,
      "STORE_ADMIN_SETUP_TOKEN 未配置，注册入口已关闭",
    );
  }
  if (!tokenMatches(input.token, config.adminSetupToken)) {
    throw new AdminError("invalid_setup_token", 403, "setup token 不正确");
  }

  const username = input.username.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(username)) {
    throw new AdminError(
      "invalid_username",
      400,
      "用户名需为 3-32 位字母、数字、点、下划线或连字符，且以字母或数字开头",
    );
  }

  const passwordProblem = validatePassword(input.password, username);
  if (passwordProblem) {
    throw new AdminError("invalid_password", 400, passwordProblem);
  }

  const passwordHash = hashPassword(input.password);

  return db.transaction(async (tx) => {
    // Serialise concurrent registrations: without the lock two requests both see an empty
    // table and both become "the first admin".
    await tx.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK})`);

    const [existing] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(adminAccounts);
    if ((existing?.count ?? 0) > 0) {
      throw new AdminError("already_initialized", 409, "管理员已存在，注册入口已关闭");
    }

    const [row] = await tx
      .insert(adminAccounts)
      .values({
        username,
        passwordHash,
        displayName: input.displayName?.trim() || username,
        mustChangePassword: false,
      })
      .returning({ id: adminAccounts.id, username: adminAccounts.username });

    if (!row) throw new AdminError("registration_failed", 500);

    await recordAudit(tx, {
      actorAdminId: row.id,
      action: "admin.bootstrap.registered",
      targetType: "admin",
      targetId: row.id,
      details: { username: row.username, userAgent: input.userAgent ?? null },
      ip: input.ip ?? null,
    });

    return { id: row.id, username: row.username };
  });
}
