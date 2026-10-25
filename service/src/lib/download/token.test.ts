import { describe, expect, test } from "bun:test";

import { signPayload } from "@/lib/crypto";
import {
  signDownloadToken,
  verifyDownloadToken,
  type DownloadClaims,
} from "./token";

const SECRET = "download-secret-for-tests-0123456789abcdef";
const OTHER_SECRET = "another-download-secret-0123456789abcdef";
const ASSET_ID = "3f6c1f7e-9a1d-4c2b-8f3e-1a2b3c4d5e6f";

function claims(overrides: Partial<DownloadClaims> = {}): DownloadClaims {
  return {
    a: ASSET_ID,
    s: "a".repeat(64),
    e: 1_700_000_000,
    ...overrides,
  };
}

describe("download token", () => {
  test("round-trips the claims", () => {
    const token = signDownloadToken(claims(), SECRET);

    const result = verifyDownloadToken(token, SECRET, 1_699_999_999);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims).toEqual(claims());
  });

  test("uses base64url(payload).base64url(hmac) with no padding", () => {
    const token = signDownloadToken(claims(), SECRET);
    const parts = token.split(".");

    expect(parts).toHaveLength(2);
    expect(token).not.toContain("=");
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"))).toEqual(
      claims(),
    );
    expect(parts[1]).toBe(signPayload(parts[0]!, SECRET));
  });

  test("rejects a tampered signature", () => {
    const token = signDownloadToken(claims(), SECRET);
    const [payload, signature] = token.split(".") as [string, string];
    const flipped = signature.startsWith("A") ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;

    expect(verifyDownloadToken(`${payload}.${flipped}`, SECRET, 0)).toEqual({
      ok: false,
      code: "token_invalid",
    });
    expect(verifyDownloadToken(`${payload}.`, SECRET, 0)).toEqual({
      ok: false,
      code: "token_invalid",
    });
  });

  test("rejects a tampered payload even with a signature present", () => {
    const token = signDownloadToken(claims(), SECRET);
    const [, signature] = token.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify(claims({ s: "b".repeat(64) })),
      "utf8",
    ).toString("base64url");

    expect(verifyDownloadToken(`${forged}.${signature}`, SECRET, 0)).toEqual({
      ok: false,
      code: "token_invalid",
    });
  });

  test("reports an expired token as token_expired", () => {
    const token = signDownloadToken(claims({ e: 1_000 }), SECRET);

    expect(verifyDownloadToken(token, SECRET, 1_000)).toEqual({
      ok: false,
      code: "token_expired",
    });
    expect(verifyDownloadToken(token, SECRET, 1_001)).toEqual({
      ok: false,
      code: "token_expired",
    });
    expect(verifyDownloadToken(token, SECRET, 999).ok).toBe(true);
  });

  test("checks the signature before the expiry", () => {
    const token = signDownloadToken(claims({ e: 1 }), SECRET);

    // Expired *and* signed by another secret: never our token, so never "expired".
    expect(verifyDownloadToken(token, OTHER_SECRET, 2_000)).toEqual({
      ok: false,
      code: "token_invalid",
    });
  });

  test("rejects a token signed with another secret", () => {
    const token = signDownloadToken(claims(), OTHER_SECRET);
    expect(verifyDownloadToken(token, SECRET, 0)).toEqual({
      ok: false,
      code: "token_invalid",
    });
  });

  test("rejects structural problems", () => {
    const token = signDownloadToken(claims(), SECRET);
    const [payload, signature] = token.split(".") as [string, string];

    const broken = [
      "",
      "single-part",
      `${token}.extra`,
      `.${signature}`,
      `${payload}.`,
      `${payload}.${signature}.`,
      `${payload}*.${signature}`,
      `${payload}.${signature} `,
    ];
    for (const candidate of broken) {
      expect(verifyDownloadToken(candidate, SECRET, 0)).toEqual({
        ok: false,
        code: "token_invalid",
      });
    }
  });

  test("rejects a correctly signed payload that is not a claims object", () => {
    const encode = (value: string) =>
      Buffer.from(value, "utf8").toString("base64url");

    const payloads = [
      "not json",
      "[]",
      "null",
      "{}",
      JSON.stringify({ a: ASSET_ID, s: "a".repeat(64), e: "1700000000" }),
      JSON.stringify({ a: ASSET_ID, s: "a".repeat(64), e: 1.5 }),
      JSON.stringify({ s: "a".repeat(64), e: 1_700_000_000 }),
      JSON.stringify({ a: "", s: "a".repeat(64), e: 1_700_000_000 }),
      JSON.stringify({ a: "42", s: "a".repeat(64), e: 1_700_000_000 }),
      JSON.stringify({ a: ASSET_ID, s: "a".repeat(200), e: 1_700_000_000 }),
    ];

    for (const raw of payloads) {
      const payload = encode(raw);
      const forged = `${payload}.${signPayload(payload, SECRET)}`;
      expect(verifyDownloadToken(forged, SECRET, 0)).toEqual({
        ok: false,
        code: "token_invalid",
      });
    }
  });

  test("bounds token length", () => {
    const token = signDownloadToken(claims(), SECRET);
    const oversized = `${"A".repeat(4096)}.${token.split(".")[1]!}`;
    expect(verifyDownloadToken(oversized, SECRET, 0)).toEqual({
      ok: false,
      code: "token_invalid",
    });
  });
});
