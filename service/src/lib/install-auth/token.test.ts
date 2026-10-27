import { describe, expect, test } from "bun:test";

import {
  ACCOUNT_TOKEN_PREFIX,
  VERIFIER_MAX_LENGTH,
  VERIFIER_MIN_LENGTH,
} from "./constants";
import {
  hashAccountToken,
  isAccountTokenShape,
  isValidVerifier,
  mintAccountToken,
} from "./token";

/**
 * Token shape and hashing.
 *
 * The two properties that matter: every minted token passes the shape check (so a caller
 * cannot mint something the API will later refuse), and the hash is stable across processes
 * (the database stores only the hash, so a restart must still find the row).
 */

describe("account tokens", () => {
  test("minted tokens carry the prefix and pass the shape check", () => {
    for (let i = 0; i < 50; i += 1) {
      const token = mintAccountToken();
      expect(token.startsWith(ACCOUNT_TOKEN_PREFIX)).toBe(true);
      expect(token.length).toBe(ACCOUNT_TOKEN_PREFIX.length + 43);
      expect(isAccountTokenShape(token)).toBe(true);
    }
  });

  test("every mint is distinct", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(mintAccountToken());
    expect(seen.size).toBe(200);
  });

  test("the hash is stable and hides the token", () => {
    const token = mintAccountToken();
    const hash = hashAccountToken(token);
    expect(hash).toBe(hashAccountToken(token));
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("near-miss shapes are refused before any lookup", () => {
    const valid = mintAccountToken();
    const cases = [
      "",
      "sfo_",
      valid.slice(0, -1),
      `${valid}x`,
      `SFO_${valid.slice(4)}`,
      `Bearer ${valid}`,
      `sfo_${"!".repeat(43)}`,
      "not-a-token",
    ];
    for (const value of cases) {
      expect(isAccountTokenShape(value)).toBe(false);
    }
  });
});

describe("PKCE verifier shape", () => {
  test("accepts the RFC 7636 window and refuses the edges", () => {
    expect(isValidVerifier("a".repeat(VERIFIER_MIN_LENGTH))).toBe(true);
    expect(isValidVerifier("a".repeat(VERIFIER_MAX_LENGTH))).toBe(true);
    expect(isValidVerifier("a".repeat(VERIFIER_MIN_LENGTH - 1))).toBe(false);
    expect(isValidVerifier("a".repeat(VERIFIER_MAX_LENGTH + 1))).toBe(false);
    expect(isValidVerifier("a".repeat(50) + " ")).toBe(false);
    expect(isValidVerifier("a".repeat(50) + "!")).toBe(false);
  });
});
