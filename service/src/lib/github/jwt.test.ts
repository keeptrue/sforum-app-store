import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { createAppJwt } from "./jwt";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

describe("GitHub App JWT", () => {
  test("signs a verifiable RS256 JWT with the expected claims", () => {
    const now = Date.UTC(2026, 9, 24, 0, 0, 0);
    const jwt = createAppJwt({
      appId: 12345,
      privateKeyPem: privateKey,
      kid: "k1",
      now,
    });

    const [header, payload, signature] = jwt.split(".");
    expect(header).toBeTruthy();
    expect(payload).toBeTruthy();
    expect(
      createVerify("RSA-SHA256")
        .update(`${header}.${payload}`)
        .verify(publicKey, signature, "base64url"),
    ).toBe(true);

    const headerJson = JSON.parse(
      Buffer.from(header, "base64url").toString("utf8"),
    );
    const payloadJson = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    expect(headerJson).toMatchObject({ alg: "RS256", typ: "JWT", kid: "k1" });
    expect(payloadJson.iss).toBe(12345);
    expect(payloadJson.exp - payloadJson.iat).toBe(600);
  });
});
