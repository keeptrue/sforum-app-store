import { signPayload, verifySignature } from "@/lib/crypto";

export type OAuthState = {
  state: string;
  verifier: string;
  issuerKey: string;
  redirectTo: string;
  exp: number;
};

export function encodeState(payload: OAuthState, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${encoded}.${signPayload(encoded, secret)}`;
}

export function decodeState(
  value: string,
  secret: string,
): OAuthState | null {
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const encoded = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!verifySignature(encoded, signature, secret)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const input = payload as Record<string, unknown>;
  if (
    typeof input.state !== "string" ||
    typeof input.verifier !== "string" ||
    typeof input.issuerKey !== "string" ||
    typeof input.redirectTo !== "string" ||
    typeof input.exp !== "number"
  ) {
    return null;
  }
  if (input.exp * 1000 <= Date.now()) return null;

  return {
    state: input.state,
    verifier: input.verifier,
    issuerKey: input.issuerKey,
    redirectTo: input.redirectTo,
    exp: input.exp,
  };
}
