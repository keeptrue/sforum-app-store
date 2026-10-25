import { describe, expect, test } from "bun:test";

import {
  decryptSecret,
  encryptSecret,
  parseKeyring,
  sha256Hex,
  signPayload,
  verifySignature,
} from "./crypto";

const keyOne = Buffer.alloc(32, 1).toString("base64");
const keyTwo = Buffer.alloc(32, 2).toString("base64");

describe("crypto", () => {
  test("encrypts and decrypts with the newest key", () => {
    const keyring = parseKeyring(`k1:${keyOne}`);
    const payload = encryptSecret("refresh-token-value", keyring);
    expect(payload.startsWith("v1.k1.")).toBe(true);
    expect(payload).not.toContain("refresh-token-value");
    expect(decryptSecret(payload, keyring)).toBe("refresh-token-value");
  });

  test("rejects tampered ciphertext", () => {
    const keyring = parseKeyring(`k1:${keyOne}`);
    const parts = encryptSecret("secret", keyring).split(".");
    const last = parts[4];
    parts[4] = `${last.slice(0, -1)}${last.endsWith("A") ? "B" : "A"}`;
    expect(() => decryptSecret(parts.join("."), keyring)).toThrow();
  });

  test("can still decrypt old ciphertext after key rotation", () => {
    const oldRing = parseKeyring(`k1:${keyOne}`);
    const oldPayload = encryptSecret("old", oldRing);
    const newRing = parseKeyring(`k1:${keyOne},k2:${keyTwo}`);
    expect(decryptSecret(oldPayload, newRing)).toBe("old");
    expect(encryptSecret("new", newRing).startsWith("v1.k2.")).toBe(true);
  });

  test("rejects short keys", () => {
    expect(() =>
      parseKeyring(`k1:${Buffer.alloc(16, 1).toString("base64")}`),
    ).toThrow();
  });

  test("signs and verifies payloads", () => {
    const signature = signPayload("payload", "secret");
    expect(verifySignature("payload", signature, "secret")).toBe(true);
    expect(verifySignature("payload", signature, "other")).toBe(false);
    expect(sha256Hex("a")).toHaveLength(64);
  });
});
