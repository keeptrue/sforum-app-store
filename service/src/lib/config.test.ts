import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { adminUrl, cookieName, getConfig, resetConfigForTests } from "./config";

const key = Buffer.alloc(32, 3).toString("base64");

function setEnv(overrides: Record<string, string> = {}) {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "postgres://store:store@127.0.0.1:5432/store";
  process.env.STORE_PUBLIC_URL = "http://127.0.0.1:3000";
  process.env.STORE_SESSION_SECRET = "s".repeat(64);
  process.env.STORE_DOWNLOAD_SECRET = "d".repeat(64);
  process.env.STORE_SECRET_KEYS = `k1:${key}`;
  delete process.env.STORE_ADMIN_PATH;
  delete process.env.STORE_ADMIN_SETUP_TOKEN;
  Object.assign(process.env, overrides);
  resetConfigForTests();
}

describe("config", () => {
  beforeEach(() => setEnv());
  afterEach(() => resetConfigForTests());

  test("parses the keyring and cookie shape", () => {
    const config = getConfig();
    expect(config.keyring.size).toBe(1);
    expect(cookieName(false, "session")).toBe("store_session");
    expect(cookieName(false, "admin_session")).toBe("store_admin_session");
    expect(config.adminSessionTtlSeconds).toBe(8 * 60 * 60);
  });

  test("the public URL is a seed, and https flips cookies to the __Host- prefix", () => {
    // The prefix is not cosmetic: browsers refuse `__Host-` without Secure, so an https
    // public URL reached over http would silently drop every cookie. Both sides move together,
    // which is why `cookieName` takes the secure flag the effective URL resolved to.
    setEnv({ STORE_PUBLIC_URL: "https://store.example.com" });
    const config = getConfig();
    expect(config.publicUrlSeed).toBe("https://store.example.com");
    expect(cookieName(true, "session")).toBe("__Host-store_session");
    expect(cookieName(true, "admin_session")).toBe("__Host-store_admin_session");
    expect(cookieName(true, "oauth_state")).toBe("__Host-store_oauth_state");
  });

  test("admin path defaults to /admin", () => {
    const config = getConfig();
    expect(config.adminPath).toBe("admin");
    expect(adminUrl(config)).toBe("/admin");
    expect(adminUrl(config, "accounts")).toBe("/admin/accounts");
    expect(adminUrl(config, "/audit?page=2")).toBe("/admin/audit?page=2");
  });

  test("admin path accepts a custom segment with or without slashes", () => {
    setEnv({ STORE_ADMIN_PATH: "/ops/" });
    expect(getConfig().adminPath).toBe("ops");
  });

  test("admin path refuses a multi-segment value", () => {
    // The console lives on a top-level dynamic segment, so it can only eat one segment.
    setEnv({ STORE_ADMIN_PATH: "/ops/admin" });
    expect(() => getConfig()).toThrow(/single segment/);
  });

  test("admin path refuses a segment that collides with a static route", () => {
    // Static routes win over the dynamic segment; a collision would ship a dead URL.
    setEnv({ STORE_ADMIN_PATH: "/dashboard" });
    expect(() => getConfig()).toThrow(/reserved route/);
  });

  test("admin path refuses uppercase and separators", () => {
    setEnv({ STORE_ADMIN_PATH: "/Admin" });
    expect(() => getConfig()).toThrow(/single segment/);
    resetConfigForTests();
    setEnv({ STORE_ADMIN_PATH: "/a_b" });
    expect(() => getConfig()).toThrow(/single segment/);
  });

  test("setup token is optional and closed by default", () => {
    expect(getConfig().adminSetupToken).toBeNull();
  });

  test("setup token must be long enough to be worth anything", () => {
    setEnv({ STORE_ADMIN_SETUP_TOKEN: "short" });
    expect(() => getConfig()).toThrow(/at least 32 characters/);
    resetConfigForTests();
    setEnv({ STORE_ADMIN_SETUP_TOKEN: "t".repeat(32) });
    expect(getConfig().adminSetupToken).toBe("t".repeat(32));
  });

  test("rejects a bad encryption key", () => {
    setEnv({ STORE_SECRET_KEYS: "k1:c2hvcnQ=" });
    expect(() => getConfig()).toThrow(/32 bytes/);
  });

  test("requires https for the public URL in production", () => {
    setEnv({
      NODE_ENV: "production",
      STORE_PUBLIC_URL: "http://store.example.com",
    });
    expect(() => getConfig()).toThrow(/https in production/);
  });

  test("rejects a short session secret", () => {
    setEnv({ STORE_SESSION_SECRET: "short" });
    expect(() => getConfig()).toThrow(/at least 32 characters/);
  });
});
