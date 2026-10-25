import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing for store-local administrators.
 *
 * `node:crypto` scrypt on purpose: `Bun.password` only exists when the app runs under Bun,
 * and `AGENTS.md` allows falling back to `next start` on Node. A password check must not
 * depend on an API that disappears with the runtime.
 *
 * The stored string is self-describing (`scrypt$N$r$p$salt$hash`), so the cost can be raised
 * later without invalidating existing rows.
 */

const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;
// scrypt needs 128 * N * r bytes ≈ 32 MiB at these parameters; Node's default cap is 32 MiB.
const MAXMEM = 64 * 1024 * 1024;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password.normalize("NFKC"), salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return [
    "scrypt",
    N,
    R,
    P,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) {
    return false;
  }
  if (n <= 0 || r <= 0 || p <= 0) return false;

  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = scryptSync(password.normalize("NFKC"), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAXMEM,
    });
  } catch {
    // Absurd parameters in a tampered row must read as "wrong password", not a crash.
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Returns a human-readable reason, or `null` when the password is acceptable. */
export function validatePassword(password: string, username: string): string | null {
  if (password.length < PASSWORD_MIN) {
    return `密码至少 ${PASSWORD_MIN} 个字符`;
  }
  if (password.length > PASSWORD_MAX) {
    return `密码最多 ${PASSWORD_MAX} 个字符`;
  }
  if (password.trim().length === 0) return "密码不能只由空白组成";
  if (username && password.toLowerCase() === username.toLowerCase()) {
    return "密码不能与用户名相同";
  }
  return null;
}
