import { createSign } from "node:crypto";

export function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function createAppJwt(input: {
  appId: number;
  privateKeyPem: string;
  kid?: string;
  now?: number;
}): string {
  const now = input.now ?? Date.now();
  const iat = Math.floor(now / 1000) - 60;
  const exp = Math.floor(now / 1000) + 9 * 60;

  const header: Record<string, unknown> = { alg: "RS256", typ: "JWT" };
  if (input.kid) header.kid = input.kid;
  const payload = { iat, exp, iss: input.appId };

  const data = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const signature = createSign("RSA-SHA256")
    .update(data)
    .sign(input.privateKeyPem, "base64url");
  return `${data}.${signature}`;
}
