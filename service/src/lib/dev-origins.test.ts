import { describe, expect, test } from "bun:test";

import { resolveAllowedDevOrigins } from "./dev-origins";

describe("allowed dev origins", () => {
  test("always keeps the loopback hosts", () => {
    expect(resolveAllowedDevOrigins()).toEqual(["127.0.0.1", "[::1]", "::1"]);
  });

  test("appends configured hosts after the loopback ones", () => {
    expect(
      resolveAllowedDevOrigins("*.trycloudflare.com,store.example.com"),
    ).toEqual([
      "127.0.0.1",
      "[::1]",
      "::1",
      "*.trycloudflare.com",
      "store.example.com",
    ]);
  });

  test("tolerates whitespace and empty entries", () => {
    expect(resolveAllowedDevOrigins("  , *.trycloudflare.com ,, ")).toEqual([
      "127.0.0.1",
      "[::1]",
      "::1",
      "*.trycloudflare.com",
    ]);
  });

  test("treats a blank value as no extra hosts", () => {
    expect(resolveAllowedDevOrigins("")).toHaveLength(3);
    expect(resolveAllowedDevOrigins("   ")).toHaveLength(3);
  });
});
