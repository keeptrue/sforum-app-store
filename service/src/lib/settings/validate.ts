import { AdminError } from "@/lib/admin/errors";
import { isLoopbackHost } from "@/lib/config";
import {
  ADMIN_LOGIN_MIN_LIMIT,
  RATE_LIMIT_CHANNELS,
  parseRuleSpec,
  type RateLimitChannel,
} from "@/lib/ratelimit/rules";
import { ConfigError } from "@/lib/config";

/**
 * Validation for the console-editable runtime settings.
 *
 * Pure functions, no database and no Next: the save path turns a rejection into a 400 with the
 * operator's language, and the read path treats a stored-but-invalid value as "ignored, fall
 * back to the env seed". One implementation for both, so a value that passes the form can
 * never be a value the runtime refuses.
 */

/** How long a signed download link lives when nothing is configured. */
export const DEFAULT_DOWNLOAD_TTL_SECONDS = 30 * 60;
/** 5 minutes: shorter than this and a slow install can outlive its own link. */
export const DOWNLOAD_TTL_MIN_SECONDS = 5 * 60;
/** 24 hours: a link is a bearer credential, not a permanent address. */
export const DOWNLOAD_TTL_MAX_SECONDS = 24 * 60 * 60;

/**
 * The floor lives with the parser so the env layer and the console cannot disagree; it is
 * re-exported here because this module is where the form's rules are read from.
 */
export { ADMIN_LOGIN_MIN_LIMIT };

function invalid(code: string, message: string): AdminError {
  return new AdminError(code, 400, message);
}

/**
 * A base URL this service can emit: absolute, http(s), no credentials, no query, no fragment.
 *
 * A path prefix is allowed (`https://example.com/store`) because reverse proxies mount
 * services under one; the value is normalised to `origin + path` without a trailing slash so
 * `${publicUrl}/api/...` can never produce a double slash.
 */
export function normalizePublicUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw invalid("invalid_public_url", "对外地址不能为空");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw invalid(
      "invalid_public_url",
      "对外地址必须是完整 URL，包含 http:// 或 https://（例如 https://store.example.com）",
    );
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalid("invalid_public_url", "对外地址不是合法 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalid("invalid_public_url", "对外地址只能用 http 或 https");
  }
  if (!url.hostname) throw invalid("invalid_public_url", "对外地址缺少主机名");
  // Credentials in the base URL would be printed in every redirect and every console page.
  if (url.username || url.password) {
    throw invalid("invalid_public_url", "对外地址不能带用户名或密码");
  }
  if (url.search || url.hash) {
    throw invalid("invalid_public_url", "对外地址不能带查询串或锚点");
  }

  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "/" ? "" : path}`;
}

/**
 * Production may not emit plain-http absolute URLs for a routable host: every OAuth callback
 * and download link would be downgradeable. Loopback stays allowed for a single-box trial.
 */
export function assertPublicUrlScheme(
  publicUrl: string,
  options: { production: boolean },
): void {
  if (!options.production) return;
  const url = new URL(publicUrl);
  if (url.protocol === "https:") return;
  if (isLoopbackHost(url.hostname)) return;
  throw invalid(
    "invalid_public_url",
    "生产环境的对外地址必须使用 https（只有 127.0.0.1 / localhost 允许 http）",
  );
}

/** `null` means "use the built-in default"; empty input means the same thing. */
export function parseDownloadTtl(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const text = typeof raw === "number" ? String(raw) : String(raw).trim();
  if (!text) return null;

  const value = Number(text);
  if (!Number.isInteger(value)) {
    throw invalid("invalid_download_ttl", "下载链接有效期必须是整数秒");
  }
  if (value < DOWNLOAD_TTL_MIN_SECONDS || value > DOWNLOAD_TTL_MAX_SECONDS) {
    throw invalid(
      "invalid_download_ttl",
      `下载链接有效期必须在 ${DOWNLOAD_TTL_MIN_SECONDS / 60} 分钟到 ${
        DOWNLOAD_TTL_MAX_SECONDS / 3600
      } 小时之间`,
    );
  }
  return value;
}

/**
 * `null` means "follow `STORE_DOWNLOAD_MODE`", which is the console's third option and the
 * state a fresh row is in. Anything else is a value the operator pinned.
 */
export function parseDownloadMode(raw: unknown): "proxy" | "redirect" | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().toLowerCase();
  if (!text) return null;
  if (text === "proxy" || text === "redirect") return text;
  throw invalid(
    "invalid_download_mode",
    '下载分发形态只能是 "proxy"（商城转发）或 "redirect"（302 直链）；留空表示跟随环境变量',
  );
}

export type RateLimitOverrides = Partial<Record<RateLimitChannel, string>>;

/**
 * `{ login: "10/300" }`. An empty string clears that channel's override (back to env/default),
 * which is what the "恢复默认" control sends. An unknown channel is an error rather than a
 * silent drop: a typo must not look like it was saved.
 */
export function parseRateLimitOverrides(raw: unknown): RateLimitOverrides {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid("invalid_rate_limits", "限流配置必须是对象");
  }

  const overrides: RateLimitOverrides = {};
  for (const [channel, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(RATE_LIMIT_CHANNELS as readonly string[]).includes(channel)) {
      throw invalid("invalid_rate_limits", `未知的限流通道：${channel}`);
    }
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) continue; // cleared → inherit

    let parsed;
    try {
      parsed = parseRuleSpec(text, channel);
    } catch (error) {
      throw invalid(
        "invalid_rate_limits",
        `限流 ${channel} 的格式必须是 "<次数>/<秒>"（例如 10/300）：${
          error instanceof ConfigError ? error.message : String(error)
        }`,
      );
    }
    if (channel === "admin-login" && parsed.limit < ADMIN_LOGIN_MIN_LIMIT) {
      throw invalid(
        "invalid_rate_limits",
        `后台登录的限流不能低于 ${ADMIN_LOGIN_MIN_LIMIT} 次/窗口：再低就会把自己锁在后台外面`,
      );
    }
    overrides[channel as RateLimitChannel] = text;
  }
  return overrides;
}

/** Re-parse a value that came out of the database, without the operator-facing error path. */
export function readStoredOverride(
  channel: RateLimitChannel,
  raw: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  try {
    const parsed = parseRuleSpec(raw, channel);
    if (channel === "admin-login" && parsed.limit < ADMIN_LOGIN_MIN_LIMIT) {
      return { ok: false, reason: `低于 ${ADMIN_LOGIN_MIN_LIMIT} 次/窗口` };
    }
    return { ok: true, value: raw.trim() };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
