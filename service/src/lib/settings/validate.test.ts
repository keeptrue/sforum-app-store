import { describe, expect, test } from "bun:test";

import { AdminError } from "@/lib/admin/errors";
import {
  ADMIN_LOGIN_MIN_LIMIT,
  assertPublicUrlScheme,
  DEFAULT_DOWNLOAD_TTL_SECONDS,
  DOWNLOAD_TTL_MAX_SECONDS,
  DOWNLOAD_TTL_MIN_SECONDS,
  normalizePublicUrl,
  parseDownloadMode,
  parseDownloadTtl,
  parseRateLimitOverrides,
  readStoredOverride,
} from "./validate";

/**
 * The console's input rules. Everything the form sends passes through here before it reaches
 * the database, and the read path re-validates stored values with the same parsers — so a
 * value that survives a save is a value the runtime can use.
 */

function expectRejection(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AdminError);
    expect((error as AdminError).code).toBe(code);
    expect((error as AdminError).status).toBe(400);
    return;
  }
  throw new Error(`expected ${code}, nothing was thrown`);
}

describe("normalizePublicUrl", () => {
  test("keeps the origin and strips trailing slashes", () => {
    expect(normalizePublicUrl("https://store.example.com")).toBe("https://store.example.com");
    expect(normalizePublicUrl("https://store.example.com/")).toBe(
      "https://store.example.com",
    );
    expect(normalizePublicUrl("  https://store.example.com//  ")).toBe(
      "https://store.example.com",
    );
  });

  test("keeps a proxy path prefix without a trailing slash", () => {
    // Reverse proxies mount services under a path; `${publicUrl}/api/...` must not double up.
    expect(normalizePublicUrl("https://example.com/store/")).toBe(
      "https://example.com/store",
    );
  });

  test("keeps a non-default port", () => {
    expect(normalizePublicUrl("http://127.0.0.1:4000/")).toBe("http://127.0.0.1:4000");
  });

  test("refuses an empty value", () => {
    expectRejection(() => normalizePublicUrl("   "), "invalid_public_url");
  });

  test("refuses a bare host: the scheme is what redirects are built from", () => {
    expectRejection(() => normalizePublicUrl("store.example.com"), "invalid_public_url");
  });

  test("refuses credentials, query strings and fragments", () => {
    expectRejection(
      () => normalizePublicUrl("https://user:pass@store.example.com"),
      "invalid_public_url",
    );
    expectRejection(
      () => normalizePublicUrl("https://store.example.com/?a=1"),
      "invalid_public_url",
    );
    expectRejection(
      () => normalizePublicUrl("https://store.example.com/#top"),
      "invalid_public_url",
    );
  });

  test("refuses a non-http scheme", () => {
    expectRejection(() => normalizePublicUrl("ftp://store.example.com"), "invalid_public_url");
  });
});

describe("assertPublicUrlScheme", () => {
  test("production refuses plain http on a routable host", () => {
    expectRejection(
      () => assertPublicUrlScheme("http://store.example.com", { production: true }),
      "invalid_public_url",
    );
  });

  test("production allows http on loopback for a single-box trial", () => {
    expect(() =>
      assertPublicUrlScheme("http://127.0.0.1:4000", { production: true }),
    ).not.toThrow();
    expect(() =>
      assertPublicUrlScheme("http://localhost:4000", { production: true }),
    ).not.toThrow();
  });

  test("production allows https anywhere", () => {
    expect(() =>
      assertPublicUrlScheme("https://store.example.com", { production: true }),
    ).not.toThrow();
  });

  test("development allows http", () => {
    expect(() =>
      assertPublicUrlScheme("http://192.168.1.10:4000", { production: false }),
    ).not.toThrow();
  });
});

describe("parseDownloadTtl", () => {
  test("empty input means the built-in default", () => {
    expect(parseDownloadTtl(null)).toBeNull();
    expect(parseDownloadTtl(undefined)).toBeNull();
    expect(parseDownloadTtl("")).toBeNull();
    expect(parseDownloadTtl("   ")).toBeNull();
    expect(DEFAULT_DOWNLOAD_TTL_SECONDS).toBe(30 * 60);
  });

  test("accepts the bounds and a number as well as a string", () => {
    expect(parseDownloadTtl(DOWNLOAD_TTL_MIN_SECONDS)).toBe(DOWNLOAD_TTL_MIN_SECONDS);
    expect(parseDownloadTtl(String(DOWNLOAD_TTL_MAX_SECONDS))).toBe(
      DOWNLOAD_TTL_MAX_SECONDS,
    );
  });

  test("refuses out-of-range and non-integer values", () => {
    expectRejection(() => parseDownloadTtl(DOWNLOAD_TTL_MIN_SECONDS - 1), "invalid_download_ttl");
    expectRejection(() => parseDownloadTtl(DOWNLOAD_TTL_MAX_SECONDS + 1), "invalid_download_ttl");
    expectRejection(() => parseDownloadTtl("90.5"), "invalid_download_ttl");
    expectRejection(() => parseDownloadTtl("abc"), "invalid_download_ttl");
  });
});

describe("parseRateLimitOverrides", () => {
  test("keeps valid specs and drops cleared channels", () => {
    expect(parseRateLimitOverrides({ login: "10/300", submit: "" })).toEqual({
      login: "10/300",
    });
  });

  test("missing input is an empty override set", () => {
    expect(parseRateLimitOverrides(null)).toEqual({});
    expect(parseRateLimitOverrides(undefined)).toEqual({});
  });

  test("refuses an unknown channel instead of dropping it silently", () => {
    // A typo that saves quietly is a limit the operator believes exists and does not.
    expectRejection(
      () => parseRateLimitOverrides({ logn: "10/300" }),
      "invalid_rate_limits",
    );
  });

  test("refuses a malformed spec", () => {
    expectRejection(() => parseRateLimitOverrides({ login: "10" }), "invalid_rate_limits");
    expectRejection(() => parseRateLimitOverrides({ login: "0/300" }), "invalid_rate_limits");
  });

  test("refuses an admin-login limit that would lock the console out", () => {
    expectRejection(
      () => parseRateLimitOverrides({ "admin-login": "2/300" }),
      "invalid_rate_limits",
    );
    expect(
      parseRateLimitOverrides({ "admin-login": `${ADMIN_LOGIN_MIN_LIMIT}/300` }),
    ).toEqual({ "admin-login": `${ADMIN_LOGIN_MIN_LIMIT}/300` });
  });

  test("refuses a non-object payload", () => {
    expectRejection(() => parseRateLimitOverrides("10/300"), "invalid_rate_limits");
    expectRejection(() => parseRateLimitOverrides([1, 2]), "invalid_rate_limits");
  });
});

describe("readStoredOverride", () => {
  test("accepts a stored value that still parses", () => {
    expect(readStoredOverride("login", "5/60")).toEqual({ ok: true, value: "5/60" });
  });

  test("reports the reason instead of throwing for a hand-edited row", () => {
    const broken = readStoredOverride("login", "not-a-rule");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.reason).toContain("10/300");

    const unsafe = readStoredOverride("admin-login", "1/3600");
    expect(unsafe.ok).toBe(false);
    if (!unsafe.ok) expect(unsafe.reason).toContain(String(ADMIN_LOGIN_MIN_LIMIT));
  });
});

describe("parseDownloadMode", () => {
  test("null, undefined and an empty string all mean 跟随环境变量", () => {
    expect(parseDownloadMode(null)).toBeNull();
    expect(parseDownloadMode(undefined)).toBeNull();
    expect(parseDownloadMode("")).toBeNull();
    expect(parseDownloadMode("   ")).toBeNull();
  });

  test("accepts the two real modes, case and spaces included", () => {
    expect(parseDownloadMode("proxy")).toBe("proxy");
    expect(parseDownloadMode("redirect")).toBe("redirect");
    expect(parseDownloadMode("  Redirect ")).toBe("redirect");
  });

  test("anything else is a 400 rather than a silent fallback", () => {
    expectRejection(() => parseDownloadMode("fast"), "invalid_download_mode");
    expectRejection(() => parseDownloadMode(302), "invalid_download_mode");
    expectRejection(() => parseDownloadMode("proxy,redirect"), "invalid_download_mode");
  });
});
