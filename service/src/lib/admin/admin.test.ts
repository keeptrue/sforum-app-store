import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import { adminAccounts, accounts, storeRoles } from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import { createAdmin, listAdmins, setAdminStatus, setModeratorRole } from "@/lib/admin/accounts";
import { loginAdmin } from "@/lib/admin/auth";
import { hashPassword, validatePassword, verifyPassword } from "@/lib/admin/password";
import { findAdminSession } from "@/lib/admin/session";
import { countAdmins, hasAdmin, registerFirstAdmin } from "@/lib/admin/setup";
import type { StoreConfig } from "@/lib/config";
import { resetConfigForTests } from "@/lib/config";
import { seedIssuer } from "../../../test/issuer-fixture";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

const SETUP_TOKEN = "setup-token-for-tests-0123456789";

let db: Db;
let config: StoreConfig;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.STORE_PUBLIC_URL = "http://127.0.0.1:3000";
  process.env.STORE_SESSION_SECRET = "s".repeat(64);
  process.env.STORE_DOWNLOAD_SECRET = "d".repeat(64);
  process.env.STORE_SECRET_KEYS = `test1:${Buffer.alloc(32, 9).toString("base64")}`;
  process.env.STORE_ADMIN_SETUP_TOKEN = SETUP_TOKEN;
  resetConfigForTests();

  const { getConfig } = await import("@/lib/config");
  config = getConfig();
  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
});

beforeEach(async () => {
  await getPool().query(TRUNCATE_ALL);
});

afterAll(async () => {
  await closeDb();
  resetConfigForTests();
  delete process.env.STORE_ADMIN_SETUP_TOKEN;
});

describe("password hashing", () => {
  test("round-trips and rejects a wrong password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(hash.startsWith("scrypt$32768$8$1$")).toBe(true);
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(verifyPassword("wrong horse battery staple", hash)).toBe(false);
  });

  test("the same password hashes differently every time", () => {
    // A shared salt would let two equal passwords be spotted in the table.
    expect(hashPassword("same-password-123")).not.toBe(hashPassword("same-password-123"));
  });

  test("a tampered or foreign hash reads as a failure, not a crash", () => {
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
    expect(verifyPassword("x", "scrypt$0$0$0$AA$AA")).toBe(false);
    expect(verifyPassword("x", "scrypt$32768$8$1$AA$")).toBe(false);
  });

  test("policy: length first, no symbol theatre", () => {
    expect(validatePassword("short", "root")).toMatch(/至少 12/);
    expect(validatePassword("a".repeat(201), "root")).toMatch(/最多 200/);
    // Length is checked first, so the username comparison needs a long-enough password.
    expect(validatePassword("rootrootroot", "rootrootroot")).toMatch(/不能与用户名相同/);
    expect(validatePassword("ROOTROOTROOT", "rootrootroot")).toMatch(/不能与用户名相同/);
    expect(validatePassword("twelve-chars", "root")).toBeNull();
  });
});

describe("first administrator registration", () => {
  test("creates the first admin and marks the store initialised", async () => {
    expect(await hasAdmin(db)).toBe(false);

    const created = await registerFirstAdmin(db, config, {
      token: SETUP_TOKEN,
      username: "root",
      password: "initial-password-123",
    });

    expect(created.username).toBe("root");
    expect(await hasAdmin(db)).toBe(true);
    expect(await countAdmins(db)).toBe(1);

    const [row] = await db.select().from(adminAccounts);
    // The first admin chose their own password; no forced change.
    expect(row?.mustChangePassword).toBe(false);
    expect(row?.passwordHash.startsWith("scrypt$")).toBe(true);
    expect(row?.passwordHash).not.toContain("initial-password-123");
  });

  test("refuses a wrong setup token", async () => {
    await expect(
      registerFirstAdmin(db, config, {
        token: "wrong-token-wrong-token-wrong-token",
        username: "root",
        password: "initial-password-123",
      }),
    ).rejects.toMatchObject({ code: "invalid_setup_token" });
    expect(await hasAdmin(db)).toBe(false);
  });

  test("is closed when no setup token is configured", async () => {
    const closed = { ...config, adminSetupToken: null };
    await expect(
      registerFirstAdmin(db, closed, {
        token: SETUP_TOKEN,
        username: "root",
        password: "initial-password-123",
      }),
    ).rejects.toMatchObject({ code: "setup_disabled" });
  });

  test("refuses a second registration", async () => {
    await registerFirstAdmin(db, config, {
      token: SETUP_TOKEN,
      username: "root",
      password: "initial-password-123",
    });
    await expect(
      registerFirstAdmin(db, config, {
        token: SETUP_TOKEN,
        username: "second",
        password: "another-password-123",
      }),
    ).rejects.toMatchObject({ code: "already_initialized" });
  });

  test("concurrent registrations produce exactly one administrator", async () => {
    // The advisory lock is the only thing standing between two requests that both see an
    // empty table. Without it both would become "the first admin".
    const attempts = await Promise.allSettled([
      registerFirstAdmin(db, config, {
        token: SETUP_TOKEN,
        username: "first",
        password: "initial-password-123",
      }),
      registerFirstAdmin(db, config, {
        token: SETUP_TOKEN,
        username: "second",
        password: "initial-password-123",
      }),
    ]);

    const fulfilled = attempts.filter((item) => item.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(await countAdmins(db)).toBe(1);
  });
});

describe("admin login", () => {
  async function seedAdmin(username = "root") {
    const created = await registerFirstAdmin(db, config, {
      token: SETUP_TOKEN,
      username,
      password: "initial-password-123",
    });
    return created;
  }

  test("issues a session that resolves back to the admin", async () => {
    await seedAdmin();
    const result = await loginAdmin(db, config, {
      username: "root",
      password: "initial-password-123",
      ip: "127.0.0.1",
    });

    expect(result.username).toBe("root");
    const session = await findAdminSession(db, result.token);
    expect(session?.admin.username).toBe("root");
  });

  test("is case-insensitive on the username", async () => {
    await seedAdmin();
    const result = await loginAdmin(db, config, {
      username: "ROOT",
      password: "initial-password-123",
    });
    expect(result.username).toBe("root");
  });

  test("refuses a wrong password and counts the failure", async () => {
    await seedAdmin();
    await expect(
      loginAdmin(db, config, { username: "root", password: "nope-nope-nope" }),
    ).rejects.toMatchObject({ code: "invalid_credentials" });

    const [row] = await db.select().from(adminAccounts);
    expect(row?.failedAttempts).toBe(1);
  });

  test("locks after five failures", async () => {
    await seedAdmin();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        loginAdmin(db, config, { username: "root", password: "wrong-password-1" }),
      ).rejects.toMatchObject({ code: "invalid_credentials" });
    }
    await expect(
      loginAdmin(db, config, { username: "root", password: "wrong-password-1" }),
    ).rejects.toMatchObject({ code: "account_locked" });

    // Even the right password is refused while the lock holds.
    await expect(
      loginAdmin(db, config, { username: "root", password: "initial-password-123" }),
    ).rejects.toMatchObject({ code: "account_locked" });
  });

  test("a disabled administrator cannot log in", async () => {
    const created = await seedAdmin();
    await db
      .update(adminAccounts)
      .set({ status: "disabled" })
      .where(eq(adminAccounts.id, created.id));

    await expect(
      loginAdmin(db, config, { username: "root", password: "initial-password-123" }),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
  });
});

describe("account administration", () => {
  test("a created administrator must change the initial password", async () => {
    const root = await registerFirstAdmin(db, config, {
      token: SETUP_TOKEN,
      username: "root",
      password: "initial-password-123",
    });

    const created = await createAdmin(db, {
      username: "helper",
      password: "handover-password-1",
      actorAdminId: root.id,
    });

    const [row] = await db
      .select()
      .from(adminAccounts)
      .where(eq(adminAccounts.id, created.id));
    expect(row?.mustChangePassword).toBe(true);
  });

  test("refuses to disable the last active administrator", async () => {
    const root = await registerFirstAdmin(db, config, {
      token: SETUP_TOKEN,
      username: "root",
      password: "initial-password-123",
    });

    await expect(
      setAdminStatus(db, {
        adminId: root.id,
        status: "disabled",
        actorAdminId: root.id,
      }),
    ).rejects.toMatchObject({ code: "last_admin" });
  });

  test("allows disabling one admin while another remains", async () => {
    const root = await registerFirstAdmin(db, config, {
      token: SETUP_TOKEN,
      username: "root",
      password: "initial-password-123",
    });
    const helper = await createAdmin(db, {
      username: "helper",
      password: "handover-password-1",
      actorAdminId: root.id,
    });

    await setAdminStatus(db, {
      adminId: helper.id,
      status: "disabled",
      actorAdminId: root.id,
    });

    const admins = await listAdmins(db);
    expect(admins.find((item) => item.id === helper.id)?.status).toBe("disabled");
  });

  test("grants and revokes moderator on a forum account", async () => {
    const root = await registerFirstAdmin(db, config, {
      token: SETUP_TOKEN,
      username: "root",
      password: "initial-password-123",
    });
    await seedIssuer(db, config);
    const [account] = await db
      .insert(accounts)
      .values({ issuerKey: "official", sub: "42", username: "lin" })
      .returning();

    await setModeratorRole(db, {
      accountId: account!.id,
      granted: true,
      actorAdminId: root.id,
    });
    let roles = await db.select().from(storeRoles);
    expect(roles.map((row) => row.role)).toEqual(["moderator"]);

    await setModeratorRole(db, {
      accountId: account!.id,
      granted: false,
      actorAdminId: root.id,
    });
    roles = await db.select().from(storeRoles);
    expect(roles).toHaveLength(0);
  });
});
