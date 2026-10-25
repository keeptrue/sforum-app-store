import { describe, expect, test } from "bun:test";

import {
  decodeInstallState,
  encodeInstallState,
  verifyInstallState,
} from "./install-state";

const secret = "s".repeat(64);
const payload = {
  accountId: "00000000-0000-0000-0000-000000000001",
  nonce: "nonce-1",
  exp: Math.floor(Date.now() / 1000) + 60,
};

describe("GitHub install state", () => {
  test("round-trips a signed state", () => {
    const encoded = encodeInstallState(payload, secret);
    expect(decodeInstallState(encoded, secret)).toEqual(payload);
  });

  test("rejects tampering and expiry", () => {
    const encoded = encodeInstallState(payload, secret);
    expect(decodeInstallState(`${encoded}x`, secret)).toBeNull();

    const expired = encodeInstallState(
      { ...payload, exp: Math.floor(Date.now() / 1000) - 1 },
      secret,
    );
    expect(decodeInstallState(expired, secret)).toBeNull();
  });
});

describe("install state verification", () => {
  const state = encodeInstallState(payload, secret);

  test("accepts the token we issued when the query carries it back", () => {
    expect(verifyInstallState(state, state, secret)).toEqual(payload);
  });

  /**
   * Regression: the setup route used to compare the decoded `nonce` with the query, which is
   * the whole signed token — a comparison that can never be true. Every install redirect
   * answered `state_mismatch`.
   */
  test("rejects a different query value, a missing cookie and a bad signature", () => {
    const other = encodeInstallState({ ...payload, nonce: "nonce-2" }, secret);
    expect(verifyInstallState(state, other, secret)).toBeNull();
    expect(verifyInstallState(state, null, secret)).toBeNull();
    expect(verifyInstallState(null, state, secret)).toBeNull();
    expect(verifyInstallState(state, state, "x".repeat(64))).toBeNull();
    // The nonce alone is not the token, so it must not be accepted as one.
    expect(verifyInstallState(state, payload.nonce, secret)).toBeNull();
  });
});
