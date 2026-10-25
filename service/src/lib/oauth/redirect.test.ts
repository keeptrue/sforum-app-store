import { describe, expect, test } from "bun:test";

import { sforumCallbackUrl } from "@/lib/oauth/redirect";

/**
 * The redirect URI is matched byte-for-byte by the provider, and the same string is shown in
 * the console for copying. These cases are the differences people actually type: a trailing
 * slash, a stray space, a base URL that already carries a path.
 */
describe("sforumCallbackUrl", () => {
  test("appends the callback path to a bare origin", () => {
    expect(sforumCallbackUrl("https://store.example.com")).toBe(
      "https://store.example.com/api/auth/sforum/callback",
    );
  });

  test("drops trailing slashes instead of doubling them", () => {
    expect(sforumCallbackUrl("https://store.example.com/")).toBe(
      "https://store.example.com/api/auth/sforum/callback",
    );
    expect(sforumCallbackUrl("https://store.example.com///")).toBe(
      "https://store.example.com/api/auth/sforum/callback",
    );
  });

  test("trims surrounding whitespace", () => {
    expect(sforumCallbackUrl("  http://127.0.0.1:4000  ")).toBe(
      "http://127.0.0.1:4000/api/auth/sforum/callback",
    );
  });

  test("keeps a base path when the store is mounted under one", () => {
    expect(sforumCallbackUrl("https://example.com/store")).toBe(
      "https://example.com/store/api/auth/sforum/callback",
    );
  });
});
