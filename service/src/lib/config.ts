import { join } from "node:path";

import { parseKeyring, type Keyring } from "./crypto";

/**
 * GitHub App credentials. Declaration only: nothing here is read from env any more — the row
 * in `github_app_config` is the single source of truth and `lib/github/app-config.ts` turns it
 * into this shape (2026-10-25).
 */
export type GithubConfig = {
  appId: number;
  slug: string;
  webhookSecret: string;
  /** `kid` → PEM, oldest first. `GithubAppClient` signs with the last entry. */
  privateKeys: Map<string, string>;
  apiBaseUrl: string;
};

export type StoreConfig = {
  nodeEnv: string;
  /**
   * `STORE_PUBLIC_URL` as parsed at boot. It is the **seed**, not the truth: once an operator
   * saves a value under 系统设置, `store_settings.public_url` wins and this is only what
   * "恢复默认" returns to (`lib/settings/runtime.ts` resolves the effective value).
   */
  publicUrlSeed: string;
  databaseUrl: string;
  sessionSecret: string;
  keyring: Keyring;
  /** Admin console path segment, without a leading slash. Defaults to `admin`. */
  adminPath: string;
  /**
   * One-shot token that authorises creating the first administrator. `null` closes the
   * registration route entirely instead of leaving it open to whoever arrives first.
   */
  adminSetupToken: string | null;
  adminSessionTtlSeconds: number;
  downloadSecret: string;
  /**
   * How `GET /api/v1/download/{token}` answers.
   *
   * `proxy` (default) streams the ZIP through this process. `redirect` hands the client the
   * signed object URL GitHub already minted, so the bytes never touch this machine — at the
   * cost of the yank revocation that only the proxy can enforce. Public repositories only:
   * a private repository's object URL carries its name, tag and filename.
   */
  downloadMode: "proxy" | "redirect";
  assetDir: string;
  sessionTtlSeconds: number;
  stateTtlSeconds: number;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

let cached: StoreConfig | null = null;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is required`);
  return value;
}

/** Loopback is the one host allowed to run over plain http in production. */
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function parseUrl(name: string, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${name} must use http or https`);
  }
  return url;
}

/**
 * `STORE_ADMIN_PATH` is a single path segment. The admin console is served from a top-level
 * dynamic segment, so a multi-segment path cannot be expressed; keep it to one.
 */
function parseAdminPath(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "admin";
  const segment = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(segment)) {
    throw new ConfigError(
      "STORE_ADMIN_PATH must be a single segment matching ^[a-z0-9][a-z0-9-]{0,31}$ (e.g. /admin)",
    );
  }
  // A dynamic segment sits beside these static routes; sharing a name would make the console
  // unreachable (static routes win), so refuse at boot instead of shipping a dead URL.
  const reserved = ["api", "dashboard", "moderation", "p", "_next"];
  if (reserved.includes(segment)) {
    throw new ConfigError(
      `STORE_ADMIN_PATH "${segment}" collides with a reserved route (/api, /dashboard, /moderation, /p, /_next)`,
    );
  }
  return segment;
}

/**
 * `STORE_DOWNLOAD_MODE` is a rollout switch, not a preference: it exists so a deployment can
 * try the redirect path against a real host and flip back with a restart. Anything other than
 * the two known values fails at boot instead of silently falling back to the proxy.
 */
function parseDownloadMode(raw: string | undefined): "proxy" | "redirect" {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "proxy") return "proxy";
  if (value === "redirect") return "redirect";
  throw new ConfigError(
    `STORE_DOWNLOAD_MODE must be "proxy" or "redirect", got "${raw}"`,
  );
}

function parseAdminSetupToken(raw: string | undefined): string | null {
  const token = raw?.trim();
  if (!token) return null;
  if (token.length < 32) {
    throw new ConfigError(
      "STORE_ADMIN_SETUP_TOKEN must be at least 32 characters (openssl rand -base64 32)",
    );
  }
  return token;
}

export function getConfig(): StoreConfig {
  if (cached) return cached;

  const nodeEnv = process.env.NODE_ENV ?? "development";
  const publicUrlRaw = requireEnv("STORE_PUBLIC_URL").replace(/\/+$/, "");
  const publicUrl = parseUrl("STORE_PUBLIC_URL", publicUrlRaw);
  if (nodeEnv === "production" && publicUrl.protocol !== "https:" && !isLoopbackHost(publicUrl.hostname)) {
    throw new ConfigError("STORE_PUBLIC_URL must use https in production");
  }

  const sessionSecret = requireEnv("STORE_SESSION_SECRET");
  if (sessionSecret.length < 32) {
    throw new ConfigError("STORE_SESSION_SECRET must be at least 32 characters");
  }

  const downloadSecret = requireEnv("STORE_DOWNLOAD_SECRET");
  if (downloadSecret.length < 32) {
    throw new ConfigError("STORE_DOWNLOAD_SECRET must be at least 32 characters");
  }

  const downloadMode = parseDownloadMode(process.env.STORE_DOWNLOAD_MODE);

  // A production process reached through a proxy or tunnel while this value still points at
  // loopback emits redirects, OAuth callbacks and same-origin baselines that all lead back to
  // this machine — the symptom is a login that appears to do nothing. Say it once at boot;
  // `/api/health` reports the value actually in effect for anyone who arrives after the log
  // scrolled, and the console's 系统设置 page compares it with the address bar.
  if (nodeEnv === "production" && isLoopbackHost(publicUrl.hostname)) {
    console.warn(
      `[config] STORE_PUBLIC_URL resolves to loopback (${publicUrl.origin}). ` +
        "Every redirect, OAuth callback and same-origin check will point back at this " +
        "machine. If a reverse proxy or tunnel is in front of this process, set the public " +
        "address under 系统设置 (or STORE_PUBLIC_URL before the first boot).",
    );
  }

  cached = {
    nodeEnv,
    publicUrlSeed: publicUrl.origin + publicUrl.pathname.replace(/\/+$/, ""),
    databaseUrl: requireEnv("DATABASE_URL"),
    sessionSecret,
    downloadSecret,
    downloadMode,
    assetDir: process.env.STORE_ASSET_DIR?.trim() || join(process.cwd(), ".data", "assets"),
    keyring: parseKeyring(requireEnv("STORE_SECRET_KEYS")),
    adminPath: parseAdminPath(process.env.STORE_ADMIN_PATH),
    adminSetupToken: parseAdminSetupToken(process.env.STORE_ADMIN_SETUP_TOKEN),
    adminSessionTtlSeconds: 8 * 60 * 60,
    sessionTtlSeconds: 30 * 24 * 60 * 60,
    stateTtlSeconds: 10 * 60,
  };

  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}

export type CookieName =
  | "session"
  | "admin_session"
  | "oauth_state"
  | "github_install"
  | "github_manifest";

/**
 * The `__Host-` prefix is not cosmetic: browsers refuse it without `Secure`, so the name and
 * the flag move together. `secure` comes from the *effective* public URL
 * (`lib/settings/runtime.ts`), which is why this takes a boolean instead of the whole config —
 * a caller cannot accidentally keep using the boot-time scheme after the operator switched it.
 */
export function cookieName(secure: boolean, name: CookieName): string {
  return secure ? `__Host-store_${name}` : `store_${name}`;
}

/** Absolute URL of an admin console page, e.g. `adminUrl(config)` → `/admin`. */
export function adminUrl(config: StoreConfig, sub?: string): string {
  const base = `/${config.adminPath}`;
  if (!sub) return base;
  return `${base}/${sub.replace(/^\/+/, "")}`;
}
