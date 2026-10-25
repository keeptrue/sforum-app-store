import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import { auditLog, oauthIssuers } from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import {
  createIssuer,
  listIssuers,
  retireIssuer,
  updateIssuer,
  validateIssuerInput,
  verifyIssuer,
} from "@/lib/admin/issuers";
import { registerFirstAdmin } from "@/lib/admin/setup";
import type { StoreConfig } from "@/lib/config";
import { resetConfigForTests } from "@/lib/config";

/**
 * The OAuth2 console writer. Two things matter more than CRUD here:
 *
 * 1. `validateIssuerInput` mirrors what the provider will accept, so a bad save fails in the
 *    console instead of at every future login (`client_id` 8..128, secret ≤256, issuer_key
 *    pattern, https in production).
 * 2. One deployment serves one forum: at most one `active` issuer. That is enforced in this
 *    module *and* by `oauth_issuers_single_active_idx`, and both are asserted below.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

const SETUP_TOKEN = "setup-token-for-tests-0123456789";

const baseInput = {
  issuerKey: "official",
  displayName: "官方论坛",
  baseUrl: "https://forum.example.com",
  clientId: "sfo_client_0123456789abcdef01234567",
  clientSecret: "sfos_" + "a".repeat(64),
  scopes: ["profile", "avatar"],
};

let db: Db;
let config: StoreConfig;
let adminId: string;

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
  const admin = await registerFirstAdmin(db, config, {
    token: SETUP_TOKEN,
    username: "root",
    password: "initial-password-123",
  });
  adminId = admin.id;
});

afterAll(async () => {
  await closeDb();
  resetConfigForTests();
  delete process.env.STORE_ADMIN_SETUP_TOKEN;
});

describe("validateIssuerInput", () => {
  test("accepts a well-formed issuer", () => {
    const value = validateIssuerInput(baseInput, { production: true, creating: true });
    expect(value.issuerKey).toBe("official");
    expect(value.baseUrl).toBe("https://forum.example.com");
    expect(value.scopes).toEqual(["profile", "avatar"]);
  });

  test("issuer_key is lowercase, starts alphanumeric, at most 32 chars", () => {
    for (const bad of ["Official", "-official", "", "a".repeat(33)]) {
      expect(() =>
        validateIssuerInput({ ...baseInput, issuerKey: bad }, { production: true, creating: true }),
      ).toThrow();
    }
    expect(
      validateIssuerInput({ ...baseInput, issuerKey: "a".repeat(32) }, { production: true, creating: true })
        .issuerKey,
    ).toHaveLength(32);
  });

  test("client_id must satisfy the provider's 8..128 schema", () => {
    for (const bad of ["a".repeat(7), "a".repeat(129)]) {
      expect(() =>
        validateIssuerInput({ ...baseInput, clientId: bad }, { production: true, creating: true }),
      ).toThrow();
    }
    expect(
      validateIssuerInput({ ...baseInput, clientId: "a".repeat(8) }, { production: true, creating: true })
        .clientId,
    ).toBe("a".repeat(8));
  });

  test("client_secret is required and at most 256 chars", () => {
    expect(() =>
      validateIssuerInput({ ...baseInput, clientSecret: "  " }, { production: true, creating: true }),
    ).toThrow();
    expect(() =>
      validateIssuerInput(
        { ...baseInput, clientSecret: "s".repeat(257) },
        { production: true, creating: true },
      ),
    ).toThrow();
  });

  test("production requires https except on loopback", () => {
    expect(() =>
      validateIssuerInput(
        { ...baseInput, baseUrl: "http://forum.example.com" },
        { production: true, creating: true },
      ),
    ).toThrow();
    expect(
      validateIssuerInput(
        { ...baseInput, baseUrl: "http://127.0.0.1:4000" },
        { production: true, creating: true },
      ).baseUrl,
    ).toBe("http://127.0.0.1:4000");
    // Outside production plain http is fine.
    expect(
      validateIssuerInput(
        { ...baseInput, baseUrl: "http://forum.example.com" },
        { production: false, creating: true },
      ).baseUrl,
    ).toBe("http://forum.example.com");
  });

  test("strips a trailing slash and normalises scopes", () => {
    const value = validateIssuerInput(
      { ...baseInput, baseUrl: "https://forum.example.com/", scopes: ["avatar", "avatar", "email"] },
      { production: true, creating: true },
    );
    expect(value.baseUrl).toBe("https://forum.example.com");
    // `profile` is always granted, so it is prepended instead of silently dropped.
    expect(value.scopes).toEqual(["profile", "avatar", "email"]);
  });
});

describe("createIssuer", () => {
  test("stores the secret encrypted and writes an audit row without it", async () => {
    await createIssuer(db, config, baseInput, { adminId, ip: "127.0.0.1" });

    const [row] = await db.select().from(oauthIssuers);
    expect(row?.issuerKey).toBe("official");
    expect(row?.status).toBe("active");
    expect(row?.clientSecretCiphertext).not.toContain(baseInput.clientSecret);
    expect(row?.clientSecretKid).toBeTruthy();

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "admin.issuer.created"));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]?.details)).not.toContain(baseInput.clientSecret);
    expect(audits[0]?.actorAdminId).toBe(adminId);
  });

  test("refuses a second active issuer", async () => {
    await createIssuer(db, config, baseInput, { adminId });

    await expect(
      createIssuer(
        db,
        config,
        { ...baseInput, issuerKey: "second", displayName: "第二个论坛" },
        { adminId },
      ),
    ).rejects.toMatchObject({ code: "issuer_active_exists", status: 409 });

    expect(await db.select().from(oauthIssuers)).toHaveLength(1);
  });

  test("refuses a duplicate issuer_key", async () => {
    await createIssuer(db, config, baseInput, { adminId });
    await expect(
      createIssuer(db, config, baseInput, { adminId }),
    ).rejects.toMatchObject({ code: "issuer_exists" });
  });
});

describe("single active issuer", () => {
  test("retiring frees the slot for a new forum", async () => {
    await createIssuer(db, config, baseInput, { adminId });
    const retired = await retireIssuer(db, "official", { adminId });
    expect(retired.activeRemaining).toBe(0);

    await createIssuer(
      db,
      config,
      { ...baseInput, issuerKey: "next", displayName: "新论坛", baseUrl: "https://next.example.com" },
      { adminId },
    );

    const rows = await listIssuers(db);
    expect(rows.map((row) => `${row.issuerKey}:${row.status}`).sort()).toEqual([
      "next:active",
      "official:retired",
    ]);
  });

  test("re-enabling a retired issuer is refused while another is active", async () => {
    await createIssuer(db, config, baseInput, { adminId });
    await retireIssuer(db, "official", { adminId });
    await createIssuer(
      db,
      config,
      { ...baseInput, issuerKey: "next", displayName: "新论坛" },
      { adminId },
    );

    await expect(
      updateIssuer(db, config, "official", { status: "active" }, { adminId }),
    ).rejects.toMatchObject({ code: "issuer_active_exists" });
  });

  test("the database refuses a second active row even without the service check", async () => {
    await createIssuer(db, config, baseInput, { adminId });

    // Same ciphertext shape as a real row: the unique index must be what rejects this.
    // (Drizzle's insert builder is a thenable, and drizzle wraps driver errors in
    // `DrizzleQueryError`, so read the code from the cause chain.)
    let code: string | undefined;
    try {
      await db.insert(oauthIssuers).values({
        issuerKey: "handwritten",
        displayName: "手写行",
        baseUrl: "https://other.example.com",
        clientId: "sfo_client_handwritten000000",
        clientSecretCiphertext: "kid.iv.tag",
        clientSecretKid: "kid",
        scopes: ["profile"],
        status: "active",
      });
    } catch (error) {
      const direct = error as { code?: string; cause?: { code?: string } };
      code = direct.code ?? direct.cause?.code;
    }

    expect(code).toBe("23505");
    expect(await db.select().from(oauthIssuers)).toHaveLength(1);
  });
});

describe("updateIssuer", () => {
  test("leaves the secret alone when the field is empty", async () => {
    await createIssuer(db, config, baseInput, { adminId });
    const [before] = await db.select().from(oauthIssuers);

    await updateIssuer(db, config, "official", { displayName: "改名" }, { adminId });

    const [after] = await db.select().from(oauthIssuers);
    expect(after?.displayName).toBe("改名");
    expect(after?.clientSecretCiphertext).toBe(before?.clientSecretCiphertext);
  });

  test("rotates the secret in place and records that it happened", async () => {
    await createIssuer(db, config, baseInput, { adminId });
    const [before] = await db.select().from(oauthIssuers);

    const nextSecret = "sfos_" + "b".repeat(64);
    await updateIssuer(db, config, "official", { clientSecret: nextSecret }, { adminId });

    const [after] = await db.select().from(oauthIssuers);
    expect(after?.clientSecretCiphertext).not.toBe(before?.clientSecretCiphertext);
    expect(after?.clientSecretCiphertext).not.toContain(nextSecret);

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "admin.issuer.updated"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.details).toMatchObject({ rotatedSecret: true });
    expect(JSON.stringify(audits[0]?.details)).not.toContain(nextSecret);
  });

  test("404s on an unknown issuer", async () => {
    await expect(
      updateIssuer(db, config, "missing", { displayName: "x" }, { adminId }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});

describe("verifyIssuer", () => {
  test("reports a connection failure without disabling the issuer", async () => {
    await createIssuer(
      db,
      config,
      { ...baseInput, baseUrl: "http://127.0.0.1:9" },
      { adminId },
    );

    const result = await verifyIssuer(db, "official", { timeoutMs: 400 });
    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);

    const [row] = await db.select().from(oauthIssuers);
    // A probe is a hint, never a gate: the row stays active so the operator can fix the URL.
    expect(row?.status).toBe("active");
    expect(row?.lastError).toBeTruthy();
  });
});
