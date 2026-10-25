import { signPayload, verifySignature } from "@/lib/crypto";

/**
 * Claims carried by a signed download token.
 *
 * `a` is the `release_assets.id`, `s` is the sha256 recorded when the link was issued and
 * `e` is the expiry in unix seconds. Nothing else travels in the URL: the token says *which
 * asset* the bearer may fetch, never *where* the bytes live.
 */
export type DownloadClaims = {
  a: string;
  s: string;
  e: number;
};

export type DownloadTokenResult =
  | { ok: true; claims: DownloadClaims }
  | { ok: false; code: "token_invalid" | "token_expired" };

// base64url without padding; anything else is a structural failure, not a signature failure.
const PART_PATTERN = /^[A-Za-z0-9_-]+$/;
// `a` is a `release_assets.id` (uuid); rejecting other shapes keeps a malformed claim from
// ever reaching the database as an unparseable uuid.
const ASSET_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TOKEN_LENGTH = 2048;
const MAX_CLAIM_LENGTH = 128;

/**
 * token = base64url(JSON(claims)) + "." + base64url(HMAC-SHA256(payloadPart, secret)).
 *
 * The signature covers the encoded payload text, not the decoded JSON, so there is exactly
 * one valid encoding per claims set and no re-serialisation ambiguity.
 */
export function signDownloadToken(
  claims: DownloadClaims,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  return `${payload}.${signPayload(payload, secret)}`;
}

/**
 * Verify structure, then signature, then expiry — in that order.
 *
 * The signature is checked before the payload is parsed so a tampered token never reaches
 * `JSON.parse` with attacker-controlled bytes, and expiry is checked last so a token that
 * never was ours can not be reported as merely stale.
 */
export function verifyDownloadToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): DownloadTokenResult {
  if (typeof token !== "string") return invalid();
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return invalid();

  const parts = token.split(".");
  if (parts.length !== 2) return invalid();

  const [payload, signature] = parts;
  if (!payload || !signature) return invalid();
  if (!PART_PATTERN.test(payload) || !PART_PATTERN.test(signature)) {
    return invalid();
  }
  if (!verifySignature(payload, signature, secret)) return invalid();

  const claims = decodeClaims(payload);
  if (!claims) return invalid();

  if (claims.e <= nowSeconds) return { ok: false, code: "token_expired" };
  return { ok: true, claims };
}

function invalid(): DownloadTokenResult {
  return { ok: false, code: "token_invalid" };
}

function decodeClaims(payload: string): DownloadClaims | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const { a, s, e } = record;
  if (typeof a !== "string" || !ASSET_ID_PATTERN.test(a)) return null;
  if (!isClaimString(s)) return null;
  if (typeof e !== "number" || !Number.isSafeInteger(e)) return null;

  return { a, s, e };
}

function isClaimString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CLAIM_LENGTH
  );
}
