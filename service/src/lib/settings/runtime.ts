import { eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import { storeSettings } from "@/db/schema";
import {
  cookieName,
  getConfig,
  isLoopbackHost,
  type CookieName,
} from "@/lib/config";
import {
  loadRateLimitRules,
  parseRuleSpec,
  RATE_LIMIT_CHANNELS,
  type RateLimitChannel,
  type RateLimitRule,
} from "@/lib/ratelimit/rules";
import {
  DEFAULT_DOWNLOAD_TTL_SECONDS,
  normalizePublicUrl,
  readStoredOverride,
} from "./validate";

/**
 * Effective runtime settings: one row in `store_settings` merged over the env seed.
 *
 * Why a cache instead of reading the row on every request: `publicUrl` is consulted by every
 * redirect, download link and same-origin check, and the rate limiter runs on the login and
 * download paths. One single-row lookup per process per window is the whole cost.
 *
 * Why 15 seconds and not "forever until restart": the web process and the worker are separate
 * processes and a deployment may run several replicas. A console save invalidates *this*
 * process immediately (the save handler calls `invalidateRuntimeConfig()` and re-reads), and
 * every other process converges within the window. Cross-process push (LISTEN/NOTIFY) is
 * deliberately not built yet: it buys a few seconds and costs a second failure mode.
 *
 * A stored value that no longer validates (hand-edited row) is **ignored**, not fatal: the env
 * seed takes over and the console reports the value as invalid. Bricking the login route over
 * one bad column would remove the page that could fix it.
 */

export type RuntimeConfig = {
  publicUrl: string;
  /** Which layer answered: the row, or the `STORE_PUBLIC_URL` seed. */
  publicUrlSource: "database" | "env";
  /** Derived from `publicUrl`: an https base means `Secure` + the `__Host-` cookie prefix. */
  cookieSecure: boolean;
  downloadTtlSeconds: number;
  downloadTtlSource: "database" | "default";
  downloadMode: "proxy" | "redirect";
  /** Which layer answered: the settings row, or the `STORE_DOWNLOAD_MODE` seed. */
  downloadModeSource: "database" | "env";
  rateLimits: Record<RateLimitChannel, RateLimitRule>;
  updatedAt: Date | null;
  updatedByAdminId: string | null;
  /** Non-fatal problems found while resolving (a stored value that had to be skipped). */
  warnings: string[];
};

const CACHE_TTL_MS = 15_000;

type CacheEntry = { config: RuntimeConfig; signature: string; expiresAt: number };
let cache: CacheEntry | null = null;

export function invalidateRuntimeConfig(): void {
  cache = null;
}

/** Test hook: the cache is module state, so a suite that rewrites env must drop it. */
export function resetRuntimeConfigForTests(): void {
  cache = null;
}

type SettingsRow = {
  publicUrl: string | null;
  downloadTtlSeconds: number | null;
  downloadMode: string | null;
  rateLimits: Record<string, string> | null;
  updatedAt: Date;
  updatedByAdminId: string | null;
};

async function readRow(db: Db): Promise<SettingsRow | null> {
  const [row] = await db
    .select({
      publicUrl: storeSettings.publicUrl,
      downloadTtlSeconds: storeSettings.downloadTtlSeconds,
      downloadMode: storeSettings.downloadMode,
      rateLimits: storeSettings.rateLimits,
      updatedAt: storeSettings.updatedAt,
      updatedByAdminId: storeSettings.updatedByAdminId,
    })
    .from(storeSettings)
    .where(eq(storeSettings.id, "default"))
    .limit(1);
  return row ?? null;
}

function resolvePublicUrl(row: SettingsRow | null): {
  publicUrl: string;
  source: "database" | "env";
  warnings: string[];
} {
  const seed = getConfig().publicUrlSeed;
  const warnings: string[] = [];

  if (row?.publicUrl) {
    try {
      return { publicUrl: normalizePublicUrl(row.publicUrl), source: "database", warnings };
    } catch (error) {
      warnings.push(
        `后台保存的对外地址无效，已回退到 STORE_PUBLIC_URL：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return { publicUrl: normalizePublicUrl(seed), source: "env", warnings };
}

/**
 * A stored mode that no longer means anything (hand-edited row) falls back to the seed and
 * is reported, exactly like a bad rate-limit override: the download route must never 500
 * because one column says `Redirect`.
 */
function resolveDownloadMode(
  row: SettingsRow | null,
  warnings: string[],
): { mode: "proxy" | "redirect"; source: "database" | "env" } {
  const seed = getConfig().downloadMode;
  const stored = row?.downloadMode?.trim().toLowerCase();
  if (!stored) return { mode: seed, source: "env" };
  if (stored === "proxy" || stored === "redirect") {
    return { mode: stored, source: "database" };
  }
  warnings.push(
    `后台保存的下载分发形态无效（${row?.downloadMode}），已回退到 STORE_DOWNLOAD_MODE：${seed}`,
  );
  return { mode: seed, source: "env" };
}

function resolveRateLimits(row: SettingsRow | null, warnings: string[]) {
  const base = loadRateLimitRules();
  const overrides = row?.rateLimits ?? {};
  const rules = {} as Record<RateLimitChannel, RateLimitRule>;

  for (const channel of RATE_LIMIT_CHANNELS) {
    const stored = overrides[channel];
    if (!stored) {
      rules[channel] = base[channel];
      continue;
    }
    const checked = readStoredOverride(channel, stored);
    if (checked.ok) {
      rules[channel] = parseRuleSpec(checked.value, channel);
    } else {
      warnings.push(`限流 ${channel} 的保存值无效，已回退到默认：${checked.reason}`);
      rules[channel] = base[channel];
    }
  }
  return rules;
}

function buildConfig(row: SettingsRow | null): RuntimeConfig {
  const resolved = resolvePublicUrl(row);
  const warnings = [...resolved.warnings];
  const rateLimits = resolveRateLimits(row, warnings);
  const download = resolveDownloadMode(row, warnings);

  // Mirrors the boot-time warning in `getConfig()`: a routable deployment that believes it
  // lives on loopback emits callbacks nobody can reach. The console surfaces this per request;
  // the log keeps a copy for anyone reading logs instead of pages.
  if (getConfig().nodeEnv === "production" && isLoopbackHost(new URL(resolved.publicUrl).hostname)) {
    console.warn(
      `[settings] public URL resolves to loopback (${resolved.publicUrl}); redirects and ` +
        "download links will point back at this machine. Set it under 系统设置.",
    );
  }

  return {
    publicUrl: resolved.publicUrl,
    publicUrlSource: resolved.source,
    cookieSecure: new URL(resolved.publicUrl).protocol === "https:",
    downloadTtlSeconds: row?.downloadTtlSeconds ?? DEFAULT_DOWNLOAD_TTL_SECONDS,
    downloadTtlSource: row?.downloadTtlSeconds ? "database" : "default",
    downloadMode: download.mode,
    downloadModeSource: download.source,
    rateLimits,
    updatedAt: row?.updatedAt ?? null,
    updatedByAdminId: row?.updatedByAdminId ?? null,
    warnings,
  };
}

/**
 * The one reader. Callers that must not see a cached value (the console right after its own
 * save, `/api/health`) pass `{ fresh: true }`.
 */
export async function getRuntimeConfig(
  db: Db,
  options: { fresh?: boolean } = {},
): Promise<RuntimeConfig> {
  const now = Date.now();
  if (!options.fresh && cache && cache.expiresAt > now) return cache.config;

  const row = await readRow(db);
  const signature = row ? `${row.updatedAt.getTime()}:${row.publicUrl ?? ""}` : "none";
  // Same signature → hand back the same object. Rate-limit callers compare rules by identity
  // nowhere today, but keeping the reference stable makes the cache observable in tests.
  const reusable = cache?.signature === signature ? cache.config : null;
  const config = reusable ?? buildConfig(row);
  cache = { config, signature, expiresAt: now + CACHE_TTL_MS };
  return config;
}

/**
 * Cookie shape for this request: name and `Secure` flag, both derived from the *effective*
 * public URL. Every cookie helper goes through here so a scheme change made in the console
 * cannot leave half the service writing `store_*` and the other half `__Host-store_*`.
 */
export async function getCookieShape(
  db: Db,
): Promise<{ secure: boolean; name: (name: CookieName) => string }> {
  const { cookieSecure } = await getRuntimeConfig(db);
  return { secure: cookieSecure, name: (name) => cookieName(cookieSecure, name) };
}

