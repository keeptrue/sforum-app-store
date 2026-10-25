import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import { auditLog, storeSettings } from "@/db/schema";
import { AdminError } from "@/lib/admin/errors";
import { registerFirstAdmin } from "@/lib/admin/setup";
import { getConfig, resetConfigForTests, type StoreConfig } from "@/lib/config";
import { DEFAULT_DOWNLOAD_TTL_SECONDS } from "@/lib/settings/validate";
import {
  clearStoreSettings,
  getStoreSettingsView,
  saveStoreSettings,
  type SaveContext,
} from "@/lib/settings/service";
import { getRuntimeConfig, resetRuntimeConfigForTests } from "@/lib/settings/runtime";
import { TRUNCATE_ALL } from "@/lib/test-support/db";

/**
 * Runtime settings: the row, the cache, and the two gates that keep an operator from locking
 * themselves out.
 *
 * The load-bearing assertion is "保存即生效": after `saveStoreSettings` the *cached* read path
 * — no `fresh: true` — must already answer the new value. That is the promise the console
 * makes, and it is the one a naive TTL-only cache would break.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

const SEED_URL = "http://127.0.0.1:3000";
const SETUP_TOKEN = "setup-token-for-tests-0123456789";

let db: Db;
let config: StoreConfig;
let adminId: string;

/** A save that arrives from the same origin the service believes it lives on. */
const SAME_ORIGIN: SaveContext = {
  requestOrigin: SEED_URL,
  requestProtocol: "http:",
  requestHost: "127.0.0.1:3000",
};

const BASE_INPUT = {
  publicUrl: SEED_URL,
  downloadTtlSeconds: null as unknown,
  downloadMode: null as unknown,
  rateLimits: undefined as unknown,
};

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.STORE_PUBLIC_URL = SEED_URL;
  process.env.STORE_SESSION_SECRET = "s".repeat(64);
  process.env.STORE_DOWNLOAD_SECRET = "d".repeat(64);
  process.env.STORE_SECRET_KEYS = `test1:${Buffer.alloc(32, 7).toString("base64")}`;
  process.env.STORE_ADMIN_SETUP_TOKEN = SETUP_TOKEN;
  delete process.env.STORE_RATELIMIT_LOGIN;
  resetConfigForTests();
  resetRuntimeConfigForTests();

  config = getConfig();
  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
});

beforeEach(async () => {
  await getPool().query(TRUNCATE_ALL);
  resetRuntimeConfigForTests();
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
  resetRuntimeConfigForTests();
  delete process.env.STORE_ADMIN_SETUP_TOKEN;
});

function actor() {
  return { adminId, ip: "127.0.0.1" };
}

async function auditRows(action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.targetType, "store_settings")))
    .orderBy(desc(auditLog.createdAt));
}

describe("runtime resolution", () => {
  test("no row → the env seed answers, with the built-in defaults behind it", async () => {
    const runtime = await getRuntimeConfig(db);

    expect(runtime.publicUrl).toBe(SEED_URL);
    expect(runtime.publicUrlSource).toBe("env");
    expect(runtime.cookieSecure).toBe(false);
    expect(runtime.downloadTtlSeconds).toBe(DEFAULT_DOWNLOAD_TTL_SECONDS);
    expect(runtime.downloadTtlSource).toBe("default");
    expect(runtime.rateLimits.login).toEqual({ limit: 10, windowSeconds: 300 });
    expect(runtime.warnings).toEqual([]);
  });

  test("an https public URL flips the cookie shape", async () => {
    await saveStoreSettings(
      db,
      { ...BASE_INPUT, publicUrl: "https://store.example.com" },
      actor(),
      { requestOrigin: "https://store.example.com", requestProtocol: "https:", requestHost: "store.example.com" },
    );

    const runtime = await getRuntimeConfig(db);
    expect(runtime.publicUrl).toBe("https://store.example.com");
    expect(runtime.cookieSecure).toBe(true);
  });

  test("a stored value that no longer parses is ignored, not fatal", async () => {
    // Hand-edited row: the read path must fall back to the seed instead of bricking login.
    await db.insert(storeSettings).values({
      id: "default",
      publicUrl: "not a url",
      rateLimits: { login: "banana" },
    });

    const runtime = await getRuntimeConfig(db, { fresh: true });
    expect(runtime.publicUrl).toBe(SEED_URL);
    expect(runtime.publicUrlSource).toBe("env");
    expect(runtime.rateLimits.login).toEqual({ limit: 10, windowSeconds: 300 });
    expect(runtime.warnings.length).toBe(2);
    expect(runtime.warnings.join("\n")).toContain("对外地址");
    expect(runtime.warnings.join("\n")).toContain("login");
  });
});

describe("saveStoreSettings", () => {
  test("saving takes effect on the next cached read — no restart, no TTL wait", async () => {
    // Warm the cache first so the assertion is about invalidation, not about a cold read.
    await getRuntimeConfig(db);

    const result = await saveStoreSettings(
      db,
      { ...BASE_INPUT, publicUrl: "https://store.example.com", downloadTtlSeconds: 600 },
      actor(),
      { requestOrigin: "https://store.example.com", requestProtocol: "https:", requestHost: "store.example.com" },
    );

    expect(result.changed).toBe(true);
    expect(result.view.publicUrl).toBe("https://store.example.com");
    expect(result.view.publicUrlSource).toBe("database");
    expect(result.view.downloadTtlSeconds).toBe(600);

    // No `fresh: true`: this is the same cached call every request makes.
    const runtime = await getRuntimeConfig(db);
    expect(runtime.publicUrl).toBe("https://store.example.com");
    expect(runtime.downloadTtlSeconds).toBe(600);
  });

  test("writes one audit line listing only what moved", async () => {
    await saveStoreSettings(
      db,
      { ...BASE_INPUT, downloadTtlSeconds: 900 },
      actor(),
      SAME_ORIGIN,
    );

    const rows = await auditRows("admin.settings.updated");
    expect(rows.length).toBe(1);
    const changes = rows[0]!.details as { changes: Array<{ key: string }> };
    expect(changes.changes.map((change) => change.key)).toEqual(["downloadTtlSeconds"]);
  });

  test("an unchanged form writes nothing", async () => {
    const changed = { ...BASE_INPUT, downloadTtlSeconds: 900 };
    await saveStoreSettings(db, changed, actor(), SAME_ORIGIN);
    expect((await auditRows("admin.settings.updated")).length).toBe(1);

    const again = await saveStoreSettings(db, changed, actor(), SAME_ORIGIN);
    expect(again.changed).toBe(false);
    expect((await auditRows("admin.settings.updated")).length).toBe(1);
  });

  test("a save that leaves the address at the seed does not pin it", async () => {
    // Pinning the seed would freeze the address against a later env change for no reason: the
    // row must only hold what the operator actually decided differently.
    await saveStoreSettings(
      db,
      { ...BASE_INPUT, downloadTtlSeconds: 900 },
      actor(),
      SAME_ORIGIN,
    );

    const [row] = await db.select({ publicUrl: storeSettings.publicUrl }).from(storeSettings);
    expect(row?.publicUrl).toBeNull();

    const runtime = await getRuntimeConfig(db);
    expect(runtime.publicUrl).toBe(SEED_URL);
    expect(runtime.publicUrlSource).toBe("env");
    expect(runtime.downloadTtlSeconds).toBe(900);
  });

  test("saving exactly what the seed already provides writes no row", async () => {
    // The seed *is* the value: storing a copy would freeze it against a later env change for
    // no benefit, so "no diff" must mean "no row" too.
    const result = await saveStoreSettings(db, BASE_INPUT, actor(), SAME_ORIGIN);
    expect(result.changed).toBe(false);
    expect(result.view.publicUrlSource).toBe("env");
    expect((await db.select({ id: storeSettings.id }).from(storeSettings)).length).toBe(0);
  });

  test("rate-limit overrides reach the limiter's rules", async () => {
    const result = await saveStoreSettings(
      db,
      { ...BASE_INPUT, rateLimits: { login: "2/60" } },
      actor(),
      SAME_ORIGIN,
    );

    expect(result.view.rateLimits.find((row) => row.channel === "login")).toMatchObject({
      override: "2/60",
      effective: "2/60",
      source: "database",
    });

    const runtime = await getRuntimeConfig(db);
    expect(runtime.rateLimits.login).toEqual({ limit: 2, windowSeconds: 60 });
    // Untouched channels keep the env/default layer.
    expect(runtime.rateLimits.submit).toEqual({ limit: 30, windowSeconds: 3600 });
  });

  test("a changed origin needs an explicit confirmation", async () => {
    // Moving hosts behind TLS: the origin gate is the one under test, so the request itself is
    // https and only the hostname changes.
    const context: SaveContext = {
      requestOrigin: "https://old.example.com",
      requestProtocol: "https:",
      requestHost: "old.example.com",
    };

    let failure: unknown;
    try {
      await saveStoreSettings(
        db,
        { ...BASE_INPUT, publicUrl: "https://new.example.com" },
        actor(),
        context,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AdminError);
    expect((failure as AdminError).code).toBe("confirm_origin_change");
    expect((failure as AdminError).status).toBe(409);
    // Nothing was written: the refusal is before the update.
    expect((await getRuntimeConfig(db, { fresh: true })).publicUrl).toBe(SEED_URL);

    const confirmed = await saveStoreSettings(
      db,
      {
        ...BASE_INPUT,
        publicUrl: "https://new.example.com",
        confirmOriginChange: true,
      },
      actor(),
      context,
    );
    expect(confirmed.view.publicUrl).toBe("https://new.example.com");
  });

  test("a TTL-only save from another hostname is not gated", async () => {
    // The operator may reach the console through a tunnel while the address is still being
    // set up; that must not turn every unrelated save into a confirmation dialog.
    const elsewhere: SaveContext = {
      requestOrigin: "https://demo.trycloudflare.com",
      requestProtocol: "https:",
      requestHost: "demo.trycloudflare.com",
    };

    const result = await saveStoreSettings(
      db,
      { ...BASE_INPUT, downloadTtlSeconds: 900 },
      actor(),
      elsewhere,
    );

    expect(result.changed).toBe(true);
    expect(result.view.downloadTtlSeconds).toBe(900);
    expect(result.view.publicUrl).toBe(SEED_URL);
  });

  test("switching to https while served over http needs its own confirmation", async () => {
    // No request origin here: isolate the scheme gate from the origin gate.
    const context: SaveContext = { requestOrigin: null, requestProtocol: "http:" };

    let failure: unknown;
    try {
      await saveStoreSettings(
        db,
        { ...BASE_INPUT, publicUrl: "https://store.example.com" },
        actor(),
        context,
      );
    } catch (error) {
      failure = error;
    }
    expect((failure as AdminError).code).toBe("confirm_insecure_transition");

    const confirmed = await saveStoreSettings(
      db,
      {
        ...BASE_INPUT,
        publicUrl: "https://store.example.com",
        confirmInsecureTransition: true,
      },
      actor(),
      context,
    );
    expect(confirmed.view.cookieSecure).toBe(true);
  });

  test("an invalid value is refused before it can reach the row", async () => {
    await expect(
      saveStoreSettings(
        db,
        { ...BASE_INPUT, publicUrl: "store.example.com" },
        actor(),
        SAME_ORIGIN,
      ),
    ).rejects.toBeInstanceOf(AdminError);

    const rows = await db.select({ id: storeSettings.id }).from(storeSettings);
    expect(rows.length).toBe(0);
  });
});

describe("download mode", () => {
  async function savedChanges(): Promise<Array<{ key: string; from: unknown; to: unknown }>> {
    const [audit] = await auditRows("admin.settings.updated");
    return (audit!.details as { changes: Array<{ key: string; from: unknown; to: unknown }> })
      .changes;
  }

  test("no row → STORE_DOWNLOAD_MODE answers and nothing is pinned", async () => {
    const runtime = await getRuntimeConfig(db);
    expect(runtime.downloadMode).toBe("proxy");
    expect(runtime.downloadModeSource).toBe("env");

    const view = await getStoreSettingsView(db);
    expect(view.downloadMode).toBe("proxy");
    expect(view.seedDownloadMode).toBe("proxy");
    expect(view.downloadModeOverride).toBeNull();
  });

  test("a console save pins redirect and is live on the cached read path", async () => {
    const result = await saveStoreSettings(
      db,
      { ...BASE_INPUT, downloadMode: "redirect" },
      actor(),
      SAME_ORIGIN,
    );

    expect(result.changed).toBe(true);
    expect(result.view.downloadMode).toBe("redirect");
    expect(result.view.downloadModeSource).toBe("database");
    expect(result.view.downloadModeOverride).toBe("redirect");
    // No `fresh`: the promise this page makes is that the next request already routes this way.
    expect((await getRuntimeConfig(db)).downloadMode).toBe("redirect");
    expect(await savedChanges()).toContainEqual({
      key: "downloadMode",
      from: "proxy",
      to: "redirect",
    });
  });

  test("picking the seed value still pins it, and the audit says so", async () => {
    const result = await saveStoreSettings(
      db,
      { ...BASE_INPUT, downloadMode: "proxy" },
      actor(),
      SAME_ORIGIN,
    );

    // Nothing an operator can observe moved…
    expect(result.view.downloadMode).toBe("proxy");
    // …but what a future `STORE_DOWNLOAD_MODE` edit would do did.
    expect(result.changed).toBe(true);
    expect(result.view.downloadModeSource).toBe("database");
    expect(await savedChanges()).toEqual([
      { key: "downloadMode.pinned", from: null, to: "proxy" },
    ]);
  });

  test("choosing 跟随环境变量 clears the pinned value", async () => {
    await saveStoreSettings(
      db,
      { ...BASE_INPUT, downloadMode: "redirect" },
      actor(),
      SAME_ORIGIN,
    );

    const cleared = await saveStoreSettings(
      db,
      { ...BASE_INPUT, downloadMode: null },
      actor(),
      SAME_ORIGIN,
    );

    expect(cleared.view.downloadMode).toBe("proxy");
    expect(cleared.view.downloadModeSource).toBe("env");
    expect(cleared.view.downloadModeOverride).toBeNull();
    const [row] = await db.select({ mode: storeSettings.downloadMode }).from(storeSettings);
    expect(row!.mode).toBeNull();
  });

  test("an unreadable stored mode falls back to the seed instead of refusing downloads", async () => {
    await db.insert(storeSettings).values({ id: "default", downloadMode: "auto" });

    const runtime = await getRuntimeConfig(db, { fresh: true });
    expect(runtime.downloadMode).toBe("proxy");
    expect(runtime.downloadModeSource).toBe("env");
    expect(runtime.warnings.some((warning) => warning.includes("分发形态"))).toBe(true);
  });

  test("a nonsense value from the form is rejected, not silently ignored", async () => {
    await expect(
      saveStoreSettings(
        db,
        { ...BASE_INPUT, downloadMode: "fast" },
        actor(),
        SAME_ORIGIN,
      ),
    ).rejects.toBeInstanceOf(AdminError);
    expect((await db.select({ id: storeSettings.id }).from(storeSettings)).length).toBe(0);
  });
});

describe("clearStoreSettings", () => {
  test("drops the row and returns every key to the seed", async () => {
    await saveStoreSettings(
      db,
      { ...BASE_INPUT, publicUrl: "https://store.example.com", downloadTtlSeconds: 600 },
      actor(),
      { requestOrigin: "https://store.example.com", requestProtocol: "https:", requestHost: "store.example.com" },
    );

    const view = await clearStoreSettings(db, actor());

    expect(view.publicUrl).toBe(SEED_URL);
    expect(view.publicUrlSource).toBe("env");
    expect(view.downloadTtlSeconds).toBe(DEFAULT_DOWNLOAD_TTL_SECONDS);
    expect((await db.select({ id: storeSettings.id }).from(storeSettings)).length).toBe(0);
    expect((await auditRows("admin.settings.reset")).length).toBe(1);
  });

  test("clearing an absent row is a no-op, not an error", async () => {
    const view = await clearStoreSettings(db, actor());
    expect(view.publicUrl).toBe(SEED_URL);
    expect((await auditRows("admin.settings.reset")).length).toBe(0);
  });
});

describe("/api/health", () => {
  test("reports the saved value, its source, and when it was written", async () => {
    // The external probe has to agree with the console: same value, and it says which layer
    // answered so an operator can tell "the console did not save" from "the request is wrong".
    const { GET } = await import("@/app/api/health/route");
    await saveStoreSettings(
      db,
      {
        ...BASE_INPUT,
        publicUrl: "https://store.example.com",
        downloadTtlSeconds: 600,
        confirmOriginChange: true,
      },
      actor(),
      { requestOrigin: "https://store.example.com", requestProtocol: "https:", requestHost: "store.example.com" },
    );

    const body = (await (await GET()).json()) as {
      publicUrl: string;
      publicUrlSource: string;
      settingsUpdatedAt: string | null;
      sessionCookie: string;
      configWarning?: string;
    };

    expect(body.publicUrl).toBe("https://store.example.com");
    expect(body.publicUrlSource).toBe("database");
    // The cookie shape follows the effective address, not the boot seed.
    expect(body.sessionCookie).toBe("__Host-store_session");
    expect(body.settingsUpdatedAt).not.toBeNull();
    expect(body.configWarning).toBeUndefined();
  });
});

describe("getStoreSettingsView", () => {
  test("reports the derived addresses the operator has to keep in sync elsewhere", async () => {
    const view = await getStoreSettingsView(db, { requestHost: "127.0.0.1:3000" });

    expect(view.derived.callbackUrl).toBe(`${SEED_URL}/api/auth/sforum/callback`);
    expect(view.derived.webhookUrl).toBe(`${SEED_URL}/api/github/webhook`);
    expect(view.derived.setupUrl).toBe(`${SEED_URL}/api/github/setup`);
    expect(view.sessionCookieName).toBe("store_session");
    expect(view.requestHost).toBe("127.0.0.1:3000");
    expect(view.updatedBy).toBeNull();
  });

  test("records who changed it last", async () => {
    await saveStoreSettings(db, { ...BASE_INPUT, downloadTtlSeconds: 600 }, actor(), SAME_ORIGIN);

    const view = await getStoreSettingsView(db);
    expect(view.updatedBy?.username).toBe("root");
    expect(view.updatedAt).not.toBeNull();
  });
});
