import { randomToken, sha256Hex } from "@/lib/crypto";
import {
  ACCOUNT_TOKEN_PREFIX,
  ACCOUNT_TOKEN_RANDOM_LENGTH,
  VERIFIER_MAX_LENGTH,
  VERIFIER_MIN_LENGTH,
} from "./constants";

/**
 * Account tokens: `sfo_` + 43 base64url characters.
 *
 * The store never keeps the plaintext. `account_tokens.token_hash` holds SHA-256 of the whole
 * string, so a database dump (or a read-only replica) yields nothing a caller could present —
 * the same reason session tokens are stored hashed.
 */

const TOKEN_PATTERN = new RegExp(
  `^${ACCOUNT_TOKEN_PREFIX}[A-Za-z0-9_-]{${ACCOUNT_TOKEN_RANDOM_LENGTH}}$`,
);

export function mintAccountToken(): string {
  return `${ACCOUNT_TOKEN_PREFIX}${randomToken(32)}`;
}

/** Structural check before any database lookup: a malformed bearer never reaches SQL. */
export function isAccountTokenShape(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function hashAccountToken(token: string): string {
  return sha256Hex(token);
}

/**
 * A PKCE verifier the plugin generated. The store only ever *checks* this shape; it does not
 * generate verifiers — that is the client's half of the protocol.
 */
export function isValidVerifier(value: string): boolean {
  if (value.length < VERIFIER_MIN_LENGTH || value.length > VERIFIER_MAX_LENGTH) {
    return false;
  }
  return /^[A-Za-z0-9._~-]+$/.test(value);
}
