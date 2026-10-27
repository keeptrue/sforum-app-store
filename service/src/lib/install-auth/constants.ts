/**
 * The numbers behind the install gate.
 *
 * Every one of these is a promise made to a plugin, so they live in one file instead of being
 * scattered across routes: the plugin's copy of `interval`/`expires_in` comes from the API
 * response, but the store has to enforce the same values it advertises.
 */

/** How long an authorization request waits for a human on `/connect/{id}`. */
export const AUTH_REQUEST_TTL_SECONDS = 5 * 60;

/** Polling floor handed to the plugin; also the minimum gap the status route accepts. */
export const AUTH_POLL_INTERVAL_SECONDS = 2;

/**
 * 30 days. A forum installs extensions rarely; anything shorter turns "connect once" into a
 * monthly chore, anything longer keeps a bearer alive past the point where anyone remembers
 * approving it. Revocation is the fast path, this is the backstop.
 */
export const ACCOUNT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** The only scope that exists today. A token without it cannot mint download URLs. */
export const ACCOUNT_TOKEN_SCOPE = "download:issue";

/** `sfo_` marks a store account token in logs, bug reports and secret scanners. */
export const ACCOUNT_TOKEN_PREFIX = "sfo_";

/** 32 random bytes, base64url without padding. */
export const ACCOUNT_TOKEN_RANDOM_LENGTH = 43;

/** RFC 7636 §4.1 verifier bounds; the forum's OAuth2 provider enforces the same window. */
export const VERIFIER_MIN_LENGTH = 43;
export const VERIFIER_MAX_LENGTH = 128;

/** S256 challenge: base64url(sha256(verifier)), always 43 characters. */
export const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** What the plugin calls itself. Untrusted: rendered as text, never as markup. */
export const CLIENT_LABEL_MAX_LENGTH = 64;

/** `last_used_at` is throttled to this, so a busy forum does not rewrite a row per install. */
export const LAST_USED_WRITE_INTERVAL_SECONDS = 60;
