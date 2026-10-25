import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import { adminAccounts, adminSessions, auditLog } from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import { hashPassword, verifyPassword } from "@/lib/admin/password";
import {
  AdminResetError,
  findAdminByUsername,
  generatePassword,
  listAdminRows,
  parseEnvText,
  parseResetArgs,
  resetAdminPassword,
} from "@/lib/admin/password-reset";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

let db: Db;
let actorId: string;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
});

beforeEach(async () => {
  await getPool().query(TRUNCATE_ALL);
  // Inserted directly: `createAdmin` needs a real actor for its own audit row, and this suite
  // only cares about the reset transition.
  const [row] = await db
    .insert(adminAccounts)
    .values({
      username: "root.admin",
      passwordHash: hashPassword("seed-password-0123456"),
      displayName: "root.admin",
    })
    .returning({ id: adminAccounts.id });
  actorId = row!.id;
});

afterAll(async () => {
  await closeDb();
});

describe("parseResetArgs", () => {
  test("defaults to the interactive path", () => {
    const { args, error } = parseResetArgs(["alice"]);
    expect(error).toBeNull();
    expect(args).toMatchObject({
      username: "alice",
      source: "interactive",
      list: false,
      json: false,
      keepSessions: false,
      help: false,
    });
  });

  test("reads every flag", () => {
    const { args, error } = parseResetArgs([
      "--json",
      "--keep-sessions",
      "--user",
      "alice",
      "--generate",
    ]);
    expect(error).toBeNull();
    expect(args.username).toBe("alice");
    expect(args.source).toBe("generated");
    expect(args.json).toBe(true);
    expect(args.keepSessions).toBe(true);
  });

  test("rejects two password sources", () => {
    const { error } = parseResetArgs(["alice", "--generate", "--password-stdin"]);
    expect(error).toContain("只能选一个");
  });

  test("rejects unknown flags, duplicate usernames and --list with a username", () => {
    expect(parseResetArgs(["alice", "--nope"]).error).toContain("未知选项");
    expect(parseResetArgs(["alice", "bob"]).error).toContain("只能指定一个用户名");
    expect(parseResetArgs(["--list", "alice"]).error).toContain("--list 不接受用户名");
    expect(parseResetArgs(["--user"]).error).toContain("需要一个用户名");
  });

  test("--list alone is fine and needs no username", () => {
    const { args, error } = parseResetArgs(["--list"]);
    expect(error).toBeNull();
    expect(args.list).toBe(true);
    expect(args.username).toBeNull();
  });
});

describe("parseEnvText", () => {
  test("reads plain, quoted and exported values, skipping comments", () => {
    const values = parseEnvText(
      [
        "# a comment",
        "",
        "DATABASE_URL=postgres://store@127.0.0.1:15432/store",
        'STORE_PUBLIC_URL="http://127.0.0.1:4000"',
        "export STORE_BUILD_VERSION='dev'",
        "not a pair",
        "=nokey",
      ].join("\n"),
    );
    expect(values.DATABASE_URL).toBe("postgres://store@127.0.0.1:15432/store");
    expect(values.STORE_PUBLIC_URL).toBe("http://127.0.0.1:4000");
    expect(values.STORE_BUILD_VERSION).toBe("dev");
    expect(Object.keys(values)).toHaveLength(3);
  });
});

describe("generatePassword", () => {
  test("produces a policy-passing password with mixed classes", () => {
    const password = generatePassword();
    expect(password).toHaveLength(24);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[0-9]/);
    expect(new Set(Array.from({ length: 20 }, () => generatePassword())).size).toBe(20);
  });
});

describe("resetAdminPassword", () => {
  test("replaces the hash, clears the lockout and ends sessions", async () => {
    await db
      .update(adminAccounts)
      .set({ failedAttempts: 4, lockedUntil: new Date(Date.now() + 60_000), mustChangePassword: true })
      .where(eq(adminAccounts.id, actorId));
    await db.insert(adminSessions).values([
      { adminId: actorId, tokenHash: "hash-a", expiresAt: new Date(Date.now() + 3_600_000) },
      { adminId: actorId, tokenHash: "hash-b", expiresAt: new Date(Date.now() + 3_600_000) },
    ]);

    const result = await resetAdminPassword(db, {
      username: "root.admin",
      password: "brand-new-password-42",
    });

    expect(result.sessionsEnded).toBe(2);
    expect(result.sessionsKept).toBe(0);

    const [row] = await db
      .select()
      .from(adminAccounts)
      .where(eq(adminAccounts.id, actorId))
      .limit(1);
    expect(row!.failedAttempts).toBe(0);
    expect(row!.lockedUntil).toBeNull();
    expect(row!.mustChangePassword).toBe(false);
    expect(verifyPassword("brand-new-password-42", row!.passwordHash)).toBe(true);
    expect(verifyPassword("seed-password-0123456", row!.passwordHash)).toBe(false);

    const sessions = await db.select().from(adminSessions).where(eq(adminSessions.adminId, actorId));
    expect(sessions).toHaveLength(0);

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "admin.password.reset_cli"), eq(auditLog.targetId, actorId)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toMatchObject({ via: "cli", sessionsEnded: 2 });
  });

  test("keeps sessions when asked", async () => {
    await db.insert(adminSessions).values({
      adminId: actorId,
      tokenHash: "hash-keep",
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const result = await resetAdminPassword(db, {
      username: "root.admin",
      password: "another-password-42",
      keepSessions: true,
    });

    expect(result.sessionsEnded).toBe(0);
    expect(result.sessionsKept).toBe(1);
    const sessions = await db.select().from(adminSessions).where(eq(adminSessions.adminId, actorId));
    expect(sessions).toHaveLength(1);
  });

  test("rejects an unknown account and a policy-breaking password", async () => {
    await expect(
      resetAdminPassword(db, { username: "ghost", password: "whatever-password-1" }),
    ).rejects.toBeInstanceOf(AdminResetError);

    await expect(
      resetAdminPassword(db, { username: "root.admin", password: "short" }),
    ).rejects.toThrow(/至少 12 个字符/);

    const [row] = await db
      .select()
      .from(adminAccounts)
      .where(eq(adminAccounts.id, actorId))
      .limit(1);
    expect(verifyPassword("seed-password-0123456", row!.passwordHash)).toBe(true);
  });

  test("looks the account up case-insensitively", async () => {
    const found = await findAdminByUsername(db, "ROOT.ADMIN");
    expect(found?.id).toBe(actorId);
    const rows = await listAdminRows(db);
    expect(rows.map((row) => row.username)).toEqual(["root.admin"]);
  });
});
