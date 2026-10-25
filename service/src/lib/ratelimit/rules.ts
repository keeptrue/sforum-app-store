import { ConfigError } from "@/lib/config";

/**
 * Per-channel rate limits. `N/seconds` strings so a deployment can tune them from env
 * without a code change; an invalid value fails at boot instead of silently disabling a
 * limit (a typo must not turn into "unlimited").
 */
export type RateLimitRule = {
  limit: number;
  windowSeconds: number;
};

export const RATE_LIMIT_CHANNELS = [
  "login",
  "admin-login",
  "submit",
  "download-ip",
  "download-token",
  "repo",
] as const;

export type RateLimitChannel = (typeof RATE_LIMIT_CHANNELS)[number];

export const RATE_LIMIT_ENV: Record<RateLimitChannel, string> = {
  login: "STORE_RATELIMIT_LOGIN",
  "admin-login": "STORE_RATELIMIT_ADMIN_LOGIN",
  submit: "STORE_RATELIMIT_SUBMIT",
  "download-ip": "STORE_RATELIMIT_DOWNLOAD_IP",
  "download-token": "STORE_RATELIMIT_DOWNLOAD_TOKEN",
  repo: "STORE_RATELIMIT_REPO",
};

/** Defaults: login 10/5min per IP, submit 30/h per account, download 60/5min per IP
 * and 20/5min per token, repo connect 30/h per account. */
export const RATE_LIMIT_DEFAULTS: Record<RateLimitChannel, string> = {
  login: "10/300",
  // Admin login is password-only, so the per-IP counter and the per-account lockout are the
  // two independent brakes. Keep both.
  "admin-login": "10/300",
  submit: "30/3600",
  "download-ip": "60/300",
  "download-token": "20/300",
  repo: "30/3600",
};

/**
 * The admin password login is the one limit that can lock the operator out of the console that
 * would fix it: the per-IP counter and the per-account lockout are the two brakes, and setting
 * the first to 1 turns a typo into a denial of access. The console refuses to save below this
 * floor (`lib/settings/validate.ts`); env is clamped to it here, with a warning, so no path can
 * configure a lockout.
 */
export const ADMIN_LOGIN_MIN_LIMIT = 3;

export function parseRuleSpec(raw: string, label: string): RateLimitRule {
  const match = /^(\d{1,6})\/(\d{1,6})$/.exec(raw.trim());
  if (!match) {
    throw new ConfigError(`${label} must look like "<limit>/<seconds>" (e.g. 10/300)`);
  }
  const limit = Number(match[1]);
  const windowSeconds = Number(match[2]);
  if (limit <= 0 || windowSeconds <= 0) {
    throw new ConfigError(`${label} must use positive numbers`);
  }
  return { limit, windowSeconds };
}

let cached: Record<RateLimitChannel, RateLimitRule> | null = null;

export function loadRateLimitRules(
  env: NodeJS.ProcessEnv = process.env,
): Record<RateLimitChannel, RateLimitRule> {
  if (env === process.env && cached) return cached;
  const rules = {} as Record<RateLimitChannel, RateLimitRule>;
  for (const channel of RATE_LIMIT_CHANNELS) {
    const key = RATE_LIMIT_ENV[channel];
    const raw = env[key]?.trim() || RATE_LIMIT_DEFAULTS[channel];
    rules[channel] = parseRuleSpec(raw, key);
  }
  const adminLogin = rules["admin-login"];
  if (adminLogin.limit < ADMIN_LOGIN_MIN_LIMIT) {
    console.warn(
      `[ratelimit] ${RATE_LIMIT_ENV["admin-login"]}=${adminLogin.limit}/${adminLogin.windowSeconds} ` +
        `is below the ${ADMIN_LOGIN_MIN_LIMIT}-per-window floor; using ` +
        `${ADMIN_LOGIN_MIN_LIMIT}/${adminLogin.windowSeconds} instead so the console stays reachable.`,
    );
    rules["admin-login"] = {
      limit: ADMIN_LOGIN_MIN_LIMIT,
      windowSeconds: adminLogin.windowSeconds,
    };
  }

  if (env === process.env) cached = rules;
  return rules;
}

export function resetRateLimitRulesForTests(): void {
  cached = null;
}
