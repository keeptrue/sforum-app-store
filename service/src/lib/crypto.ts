import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export type Keyring = Map<string, Buffer>;

const KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export function parseKeyring(raw: string): Keyring {
  const entries = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error("STORE_SECRET_KEYS must contain at least one key");
  }

  const keyring: Keyring = new Map();
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    if (separator <= 0) {
      throw new Error("STORE_SECRET_KEYS entries must be kid:base64key");
    }
    const kid = entry.slice(0, separator);
    const encoded = entry.slice(separator + 1);
    if (!KID_PATTERN.test(kid)) {
      throw new Error(`STORE_SECRET_KEYS kid "${kid}" is invalid`);
    }
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      throw new Error(`STORE_SECRET_KEYS key "${kid}" must decode to 32 bytes`);
    }
    keyring.set(kid, key);
  }
  return keyring;
}

function newestKey(keyring: Keyring): { kid: string; key: Buffer } {
  const kids = Array.from(keyring.keys());
  const kid = kids[kids.length - 1];
  const key = keyring.get(kid);
  if (!key) throw new Error("keyring is empty");
  return { kid, key };
}

export function encryptSecret(plaintext: string, keyring: Keyring): string {
  const { kid, key } = newestKey(keyring);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    kid,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(payload: string, keyring: Keyring): string {
  const [version, kid, ivPart, tagPart, ciphertextPart] = payload.split(".");
  if (version !== "v1" || !kid || !ivPart || !tagPart || !ciphertextPart) {
    throw new Error("encrypted payload is malformed");
  }
  const key = keyring.get(kid);
  if (!key) throw new Error(`unknown key id "${kid}"`);

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivPart, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64url")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function verifySignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const expected = Buffer.from(signPayload(payload, secret));
  const actual = Buffer.from(signature);
  return (
    expected.length === actual.length && timingSafeEqual(expected, actual)
  );
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
