import { describe, expect, test } from "bun:test";

import { challengeFor } from "./pkce";

describe("pkce", () => {
  test("matches the RFC 7636 S256 vector", () => {
    expect(
      challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
