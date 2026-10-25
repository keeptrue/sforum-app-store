import { describe, expect, test } from "bun:test";

import { decodeState, encodeState, type OAuthState } from "./state";

const secret = "s".repeat(64);

function payload(overrides: Partial<OAuthState> = {}): OAuthState {
  return {
    state: "state-value",
    verifier: "verifier-value",
    issuerKey: "official",
    redirectTo: "/dashboard",
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  };
}

describe("oauth state", () => {
  test("round-trips a signed payload", () => {
    const encoded = encodeState(payload(), secret);
    expect(decodeState(encoded, secret)).toEqual(payload());
  });

  test("rejects a tampered payload", () => {
    const encoded = encodeState(payload(), secret);
    expect(decodeState(`${encoded}x`, secret)).toBeNull();
  });

  test("rejects an expired payload", () => {
    const encoded = encodeState(
      payload({ exp: Math.floor(Date.now() / 1000) - 1 }),
      secret,
    );
    expect(decodeState(encoded, secret)).toBeNull();
  });
});
