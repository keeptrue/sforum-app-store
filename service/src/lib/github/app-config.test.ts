import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import {
  auditLog,
  githubAppConfig,
  githubAppPrivateKeys,
} from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import { registerFirstAdmin } from "@/lib/admin/setup";
import { getConfig, resetConfigForTests, type StoreConfig } from "@/lib/config";
import {
  GithubAppConfigError,
  addGithubAppKey,
  clearGithubAppConfig,
  getGithubAppView,
  invalidateGithubConfigCache,
  loadGithubConfig,
  parsePrivateKeyPem,
  removeGithubAppKey,
  replaceGithubAppFromManifest,
  saveGithubAppConfig,
  validateGithubAppInput,
  verifyGithubApp,
} from "./app-config";

/**
 * The GitHub App console writer (2026-10-25: the App left `.env` for the database).
 *
 * What matters beyond CRUD:
 *
 * 1. Nothing secret is readable without the keyring — the columns are ciphertext and the read
 *    model (`getGithubAppView`) never carries a secret or a key.
 * 2. A stored-but-broken App is *reported* (`GithubAppConfigError`, `readError`), never
 *    silently treated as unconfigured: a webhook that quietly stops verifying is worse than
 *    one that answers 503.
 * 3. Rotation is add-then-remove, and the last key cannot be removed — an App with no signing
 *    key cannot mint a JWT, so the console's own 验证 button would be the only way back in.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

const SETUP_TOKEN = "setup-token-for-tests-0123456789";
const WEBHOOK_SECRET = "w".repeat(32);

let db: Db;
let config: StoreConfig;
let adminId: string;
/** Two real RSA keys, generated once: 2048-bit keygen per test would dominate the suite. */
let keyA: string;
let keyB: string;

function newPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function actor() {
  return { adminId, ip: "203.0.113.9" };
}

function baseInput() {
  return {
    appId: 123_456,
    slug: "sforum-store",
    webhookSecret: WEBHOOK_SECRET,
    privateKeyPem: keyA,
  };
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.STORE_PUBLIC_URL = "http://127.0.0.1:3000";
  process.env.STORE_SESSION_SECRET = "s".repeat(64);
  process.env.STORE_DOWNLOAD_SECRET = "d".repeat(64);
  process.env.STORE_SECRET_KEYS = `test1:${Buffer.alloc(32, 11).toString("base64")}`;
  process.env.STORE_ADMIN_SETUP_TOKEN = SETUP_TOKEN;
  resetConfigForTests();

  const { getConfig: load } = await import("@/lib/config");
  config = load();
  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });

  keyA = newPem();
  keyB = newPem();
});

beforeEach(async () => {
  await getPool().query(TRUNCATE_ALL);
  invalidateGithubConfigCache();
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

describe("parsePrivateKeyPem", () => {
  test("derives a stable identity from the public key", () => {
    const first = parsePrivateKeyPem(keyA);
    const second = parsePrivateKeyPem(keyA);
    expect(first.fingerprint).toHaveLength(64);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.appKeyId).toBe(first.fingerprint.slice(0, 12));
    expect(parsePrivateKeyPem(keyB).fingerprint).not.toBe(first.fingerprint);
  });

  test("accepts a JSON-escaped paste and normalises the trailing newline", () => {
    const escaped = keyA.trim().replace(/\n/g, "\\n");
    const parsed = parsePrivateKeyPem(escaped);
    expect(parsed.pem.endsWith("\n")).toBe(true);
    expect(parsed.pem).toContain("-----BEGIN PRIVATE KEY-----");
  });

  test("rejects anything that is not an unencrypted RSA PEM", () => {
    expect(() => parsePrivateKeyPem("")).toThrow(/不能为空/);
    expect(() => parsePrivateKeyPem("hello")).toThrow(/不是 PEM 私钥/);
    expect(() =>
      parsePrivateKeyPem("-----BEGIN PRIVATE KEY-----\nnot base64\n-----END PRIVATE KEY-----"),
    ).toThrow(/无法解析/);

    const { privateKey } = generateKeyPairSync("ed25519");
    const ed25519 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => parsePrivateKeyPem(ed25519)).toThrow(/必须是 RSA/);
  });
});

describe("validateGithubAppInput", () => {
  const creating = { production: true, creating: true };

  test("accepts a complete first save", () => {
    const value = validateGithubAppInput(baseInput(), creating);
    expect(value.appId).toBe(123_456);
    expect(value.slug).toBe("sforum-store");
    expect(value.apiBaseUrl).toBe("https://api.github.com");
    expect(value.webhookSecret).toBe(WEBHOOK_SECRET);
    expect(value.privateKey?.appKeyId).toBe(parsePrivateKeyPem(keyA).appKeyId);
  });

  test("the first save needs both secrets", () => {
    expect(() =>
      validateGithubAppInput({ ...baseInput(), webhookSecret: "" }, creating),
    ).toThrow(/必须填写 webhook secret/);
    expect(() =>
      validateGithubAppInput({ ...baseInput(), privateKeyPem: "" }, creating),
    ).toThrow(/必须上传 private key/);
  });

  test("an update may omit both secrets", () => {
    const value = validateGithubAppInput(
      { appId: 1, slug: "sforum-store" },
      { production: true, creating: false },
    );
    expect(value.webhookSecret).toBeNull();
    expect(value.privateKey).toBeNull();
  });

  test("app id is a positive integer", () => {
    for (const appId of ["", "abc", "0", "-3", "1.5"]) {
      expect(() => validateGithubAppInput({ ...baseInput(), appId }, creating)).toThrow(
        /app_id 必须是正整数/,
      );
    }
  });

  test("slug is the URL name, not the display name", () => {
    for (const slug of ["", "sforum store", "-sforum", "sforum_store", "a".repeat(65)]) {
      expect(() => validateGithubAppInput({ ...baseInput(), slug }, creating)).toThrow(
        /slug/,
      );
    }
  });

  test("webhook secret has a floor and a ceiling", () => {
    expect(() =>
      validateGithubAppInput({ ...baseInput(), webhookSecret: "short" }, creating),
    ).toThrow(/至少 16 字符/);
    expect(() =>
      validateGithubAppInput({ ...baseInput(), webhookSecret: "w".repeat(257) }, creating),
    ).toThrow(/最多 256 字符/);
  });

  test("api base url defaults, normalises and refuses plain http in production", () => {
    expect(
      validateGithubAppInput({ ...baseInput(), apiBaseUrl: " https://ghe.example.com/api/v3/ " }, creating)
        .apiBaseUrl,
    ).toBe("https://ghe.example.com/api/v3");
    expect(() =>
      validateGithubAppInput({ ...baseInput(), apiBaseUrl: "http://ghe.example.com" }, creating),
    ).toThrow(/必须使用 https/);
    // Loopback stays allowed: that is how the test suites and a local GHES mock run.
    expect(
      validateGithubAppInput({ ...baseInput(), apiBaseUrl: "http://127.0.0.1:8080" }, creating)
        .apiBaseUrl,
    ).toBe("http://127.0.0.1:8080");
    expect(() =>
      validateGithubAppInput({ ...baseInput(), apiBaseUrl: "ftp://x" }, creating),
    ).toThrow(/只能用 http 或 https/);
  });
});

describe("saveGithubAppConfig", () => {
  test("stores ciphertext and nothing else", async () => {
    const { addedKey } = await saveGithubAppConfig(db, config, baseInput(), actor());
    expect(addedKey).toBe(parsePrivateKeyPem(keyA).appKeyId);

    const [row] = await db.select().from(githubAppConfig);
    expect(row?.appId).toBe(123_456);
    expect(row?.slug).toBe("sforum-store");
    expect(row?.webhookSecretCiphertext).not.toContain(WEBHOOK_SECRET);
    expect(row?.webhookSecretKeyringKid).toBe("test1");

    const [key] = await db.select().from(githubAppPrivateKeys);
    expect(key?.ciphertext).not.toContain("PRIVATE KEY");
    expect(key?.keyringKid).toBe("test1");
  });

  test("the loader returns a usable config, newest key last", async () => {
    await saveGithubAppConfig(db, config, baseInput(), actor());
    await addGithubAppKey(db, config, { privateKeyPem: keyB }, actor());

    const github = await loadGithubConfig(db);
    expect(github).not.toBeNull();
    expect(github!.appId).toBe(123_456);
    expect(github!.slug).toBe("sforum-store");
    expect(github!.webhookSecret).toBe(WEBHOOK_SECRET);
    expect(github!.apiBaseUrl).toBe("https://api.github.com");
    const kids = Array.from(github!.privateKeys.keys());
    expect(kids).toHaveLength(2);
    // `GithubAppClient` signs with the last entry, so the newest key must be last.
    expect(kids[kids.length - 1]).toBe(parsePrivateKeyPem(keyB).appKeyId);
    expect(github!.privateKeys.get(kids[0]!)).toContain("BEGIN PRIVATE KEY");
  });

  test("an update keeps the stored secret unless a new one is given", async () => {
    await saveGithubAppConfig(db, config, baseInput(), actor());
    const before = (await db.select().from(githubAppConfig))[0]!;

    await saveGithubAppConfig(
      db,
      config,
      { appId: 999, slug: "sforum-store-next", apiBaseUrl: "https://api.github.com" },
      actor(),
    );
    const after = (await db.select().from(githubAppConfig))[0]!;
    expect(after.appId).toBe(999);
    expect(after.slug).toBe("sforum-store-next");
    expect(after.webhookSecretCiphertext).toBe(before.webhookSecretCiphertext);

    await saveGithubAppConfig(
      db,
      config,
      { appId: 999, slug: "sforum-store-next", webhookSecret: "n".repeat(40) },
      actor(),
    );
    const rotated = (await db.select().from(githubAppConfig))[0]!;
    expect(rotated.webhookSecretCiphertext).not.toBe(before.webhookSecretCiphertext);
    expect((await loadGithubConfig(db))!.webhookSecret).toBe("n".repeat(40));
  });

  test("pasting the same key twice is a conflict, not a second row", async () => {
    await saveGithubAppConfig(db, config, baseInput(), actor());
    await expect(
      saveGithubAppConfig(db, config, baseInput(), actor()),
    ).rejects.toThrow(/已经在上面的列表里/);
    expect(await db.select().from(githubAppPrivateKeys)).toHaveLength(1);
  });

  test("audit records what changed, never the secret", async () => {
    await saveGithubAppConfig(db, config, baseInput(), actor());
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetType, "github_app"))
      .orderBy(desc(auditLog.createdAt));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("admin.github_app.created");
    expect(rows[0]?.actorAdminId).toBe(adminId);
    const serialized = JSON.stringify(rows[0]?.details ?? {});
    expect(serialized).not.toContain(WEBHOOK_SECRET);
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).toContain("rotatedWebhookSecret");
  });

  test("a save invalidates the process cache immediately", async () => {
    await saveGithubAppConfig(db, config, baseInput(), actor());
    expect((await loadGithubConfig(db))!.appId).toBe(123_456);

    await saveGithubAppConfig(
      db,
      config,
      { appId: 4242, slug: "sforum-store", webhookSecret: WEBHOOK_SECRET },
      actor(),
    );
    // Same process: the write must not wait out the TTL.
    expect((await loadGithubConfig(db))!.appId).toBe(4242);
  });
});

describe("private keys", () => {
  test("rotation is add-then-remove and the last key stays", async () => {
    await saveGithubAppConfig(db, config, baseInput(), actor());
    const keyAId = parsePrivateKeyPem(keyA).appKeyId;

    await expect(removeGithubAppKey(db, keyAId, actor())).rejects.toThrow(
      /不能删除最后一把私钥/,
    );

    const added = await addGithubAppKey(db, config, { privateKeyPem: keyB }, actor());
    expect(added.appKeyId).toBe(parsePrivateKeyPem(keyB).appKeyId);

    const removed = await removeGithubAppKey(db, keyAId, actor());
    expect(removed.remaining).toBe(1);

    const github = await loadGithubConfig(db);
    expect(Array.from(github!.privateKeys.keys())).toEqual([added.appKeyId]);
  });

  test("removing an unknown key is a 404", async () => {
    await saveGithubAppConfig(db, config, baseInput(), actor());
    await expect(removeGithubAppKey(db, "nope", actor())).rejects.toThrow(/私钥不存在/);
  });

  test("keys need an App to belong to", async () => {
    await expect(
      addGithubAppKey(db, config, { privateKeyPem: keyA }, actor()),
    ).rejects.toThrow(/还没有配置 GitHub App/);
  });
});

describe("getGithubAppView", () => {
  test("unconfigured: no row, no secrets, derived URLs still shown", async () => {
    const view = await getGithubAppView(db);
    expect(view.configured).toBe(false);
    expect(view.appId).toBeNull();
    expect(view.keys).toEqual([]);
    expect(view.webhookSecretSet).toBe(false);
    expect(view.webhookUrl).toBe("http://127.0.0.1:3000/api/github/webhook");
    // Setup URL is derived even before a slug exists: it is an App-setting input, not a link.
    expect(view.setupUrl).toBe("http://127.0.0.1:3000/api/github/setup");
    expect(view.installUrl).toBeNull();
  });

  test("configured: identity and key metadata only", async () => {
    await saveGithubAppConfig(db, config, baseInput(), actor());
    await addGithubAppKey(db, config, { privateKeyPem: keyB }, actor());

    const view = await getGithubAppView(db);
    expect(view.configured).toBe(true);
    expect(view.appId).toBe(123_456);
    expect(view.slug).toBe("sforum-store");
    expect(view.webhookSecretSet).toBe(true);
    expect(view.setupUrl).toBe("http://127.0.0.1:3000/api/github/setup");
    expect(view.installUrl).toBe("https://github.com/apps/sforum-store/installations/new");
    expect(view.keys).toHaveLength(2);
    expect(view.keys.map((key) => key.signing)).toEqual([false, true]);
    expect(view.readError).toBeNull();

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(WEBHOOK_SECRET);
    expect(serialized).not.toContain("PRIVATE KEY");
  });

  test("a keyring without the stored kid is reported, not silently unconfigured", async () => {
    await saveGithubAppConfig(db, config, baseInput(), actor());

    const originalKeys = process.env.STORE_SECRET_KEYS;
    process.env.STORE_SECRET_KEYS = `rotated:${Buffer.alloc(32, 12).toString("base64")}`;
    resetConfigForTests();
    invalidateGithubConfigCache();
    try {
      const view = await getGithubAppView(db);
      expect(view.configured).toBe(true);
      expect(view.readError).toContain("无法解密");
      await expect(loadGithubConfig(db)).rejects.toBeInstanceOf(GithubAppConfigError);
    } finally {
      process.env.STORE_SECRET_KEYS = originalKeys;
      resetConfigForTests();
      invalidateGithubConfigCache();
    }
    // The row itself is intact: putting the old keyring back is the whole fix.
    expect((await loadGithubConfig(db))!.appId).toBe(123_456);
  });
});

describe("verifyGithubApp", () => {
  function stubFetch(body: unknown, status = 200) {
    const original = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return Response.json(body, { status });
    }) as unknown as typeof fetch;
    return { calls, restore: () => (globalThis.fetch = original) };
  }

  test("reports the App identity and records the verification", async () => {
    await saveGithubAppConfig(db, config, baseInput(), actor());
    const stub = stubFetch({
      id: 123_456,
      slug: "sforum-store",
      name: "SForum Store",
      owner: { login: "sforum" },
    });
    try {
      const result = await verifyGithubApp(db, actor());
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.message).toContain("SForum Store");
      expect(result.app).toEqual({
        id: 123_456,
        slug: "sforum-store",
        name: "SForum Store",
        owner: "sforum",
      });
      expect(stub.calls[0]).toBe("https://api.github.com/app");
    } finally {
      stub.restore();
    }

    const [row] = await db.select().from(githubAppConfig);
    expect(row?.lastVerifiedAt).not.toBeNull();
    expect(row?.lastError).toBeNull();

    const view = await getGithubAppView(db);
    expect(view.lastVerifiedAt).not.toBeNull();

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "admin.github_app.verified"));
    expect(audits).toHaveLength(1);
  });

  test("a slug that does not belong to the key is a failure, not a pass", async () => {
    await saveGithubAppConfig(db, config, baseInput(), actor());
    const stub = stubFetch({
      id: 123_456,
      slug: "some-other-app",
      name: "SForum Store",
      owner: { login: "sforum" },
    });
    try {
      const result = await verifyGithubApp(db, actor());
      expect(result.ok).toBe(false);
      expect(result.message).toContain("slug 不匹配");
    } finally {
      stub.restore();
    }

    const [row] = await db.select().from(githubAppConfig);
    expect(row?.lastVerifiedAt).toBeNull();
    expect(row?.lastError).toContain("slug 不匹配");
  });

  test("a GitHub error is reported, never thrown at the console", async () => {
    await saveGithubAppConfig(db, config, baseInput(), actor());
    const stub = stubFetch({ message: "Bad credentials" }, 401);
    try {
      const result = await verifyGithubApp(db, actor());
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Bad credentials");
    } finally {
      stub.restore();
    }
  });

  test("verifying an unconfigured store is a 404", async () => {
    await expect(verifyGithubApp(db, actor())).rejects.toThrow(/还没有配置 GitHub App/);
  });
});

describe("clearGithubAppConfig", () => {
  test("removes the row and cascades its keys", async () => {
    await saveGithubAppConfig(db, config, baseInput(), actor());
    await addGithubAppKey(db, config, { privateKeyPem: keyB }, actor());

    await clearGithubAppConfig(db, actor());

    expect(await db.select().from(githubAppConfig)).toHaveLength(0);
    expect(await db.select().from(githubAppPrivateKeys)).toHaveLength(0);
    expect(await loadGithubConfig(db)).toBeNull();
    expect((await getGithubAppView(db)).configured).toBe(false);

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "admin.github_app.removed"));
    expect(audits).toHaveLength(1);
  });
});

/**
 * The manifest flow always produces a *new* App, so it replaces the stored one. The failure
 * this guards against is a stale signing key surviving the swap: it would still render as a
 * usable "备用" row while being unable to sign for the App that is actually stored.
 */
describe("replaceGithubAppFromManifest", () => {
  test("swaps the App, drops the old signing keys and keeps both halves in the audit trail", async () => {
    await saveGithubAppConfig(db, config, baseInput(), actor());
    await addGithubAppKey(db, config, { privateKeyPem: keyB }, actor());
    expect(await db.select().from(githubAppPrivateKeys)).toHaveLength(2);

    const result = await replaceGithubAppFromManifest(
      db,
      config,
      {
        appId: 987_654,
        slug: "sforum-store-two",
        webhookSecret: "m".repeat(32),
        privateKeyPem: keyB,
      },
      actor(),
    );

    expect(result.replacedAppId).toBe(123_456);

    const rows = await db.select().from(githubAppConfig);
    expect(rows).toHaveLength(1);
    expect(rows[0].appId).toBe(987_654);
    expect(rows[0].slug).toBe("sforum-store-two");

    // One key, and it is the one GitHub just handed us — not the previous App's two.
    const keys = await db.select().from(githubAppPrivateKeys);
    expect(keys).toHaveLength(1);
    expect(keys[0].appKeyId).toBe(parsePrivateKeyPem(keyB).appKeyId);

    const stored = await loadGithubConfig(db);
    expect(stored?.appId).toBe(987_654);
    expect(stored?.slug).toBe("sforum-store-two");
    expect(stored?.webhookSecret).toBe("m".repeat(32));
    expect(stored?.privateKeys.size).toBe(1);

    const removed = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "admin.github_app.removed"));
    const created = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "admin.github_app.created"));
    expect(removed).toHaveLength(1);
    // Two `created` rows: the seed save above, then the manifest write.
    expect(created).toHaveLength(2);
    expect(
      created.some((row) => (row.details as Record<string, unknown> | null)?.appId === 987_654),
    ).toBe(true);
    expect(removed[0].details).toMatchObject({ via: "manifest", replacedBy: 987_654 });
    expect(removed[0].targetId).toBe("123456");
  });

  test("works on a store that never had an App", async () => {
    const result = await replaceGithubAppFromManifest(
      db,
      config,
      {
        appId: 555,
        slug: "sforum-store-three",
        webhookSecret: "m".repeat(32),
        privateKeyPem: keyA,
      },
      actor(),
    );

    expect(result.replacedAppId).toBeNull();
    expect((await getGithubAppView(db)).appId).toBe(555);

    const removed = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "admin.github_app.removed"));
    expect(removed).toHaveLength(0);
  });
});
