import { eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import { adminAccounts, storeSettings } from "@/db/schema";
import { AdminError } from "@/lib/admin/errors";
import { cookieName, getConfig } from "@/lib/config";
import { githubSetupUrl, githubWebhookUrl } from "@/lib/github/app-config";
import { recordAudit } from "@/lib/moderation/events";
import { sforumCallbackUrl } from "@/lib/oauth/redirect";
import {
  RATE_LIMIT_CHANNELS,
  RATE_LIMIT_ENV,
  type RateLimitChannel,
} from "@/lib/ratelimit/rules";
import {
  getRuntimeConfig,
  invalidateRuntimeConfig,
  type RuntimeConfig,
} from "./runtime";
import {
  assertPublicUrlScheme,
  DEFAULT_DOWNLOAD_TTL_SECONDS,
  normalizePublicUrl,
  parseDownloadMode,
  parseDownloadTtl,
  parseRateLimitOverrides,
  readStoredOverride,
} from "./validate";

/**
 * The console's read/write surface for `store_settings`.
 *
 * Same shape as the GitHub App page: the view carries the effective value *and* where it came
 * from, because "saved but not in effect" is the failure this whole feature exists to prevent.
 */

const SINGLETON_ID = "default";

export type RateLimitRowView = {
  channel: RateLimitChannel;
  /** What the operator typed, or null when the channel inherits env/default. */
  override: string | null;
  /** What the limiter will actually use right now. */
  effective: string;
  source: "database" | "env" | "default";
  /** Set when the stored override could not be parsed and was skipped. */
  invalidReason: string | null;
};

export type StoreSettingsView = {
  publicUrl: string;
  publicUrlSource: "database" | "env";
  /** `STORE_PUBLIC_URL`; what "恢复默认" would return to. */
  seedPublicUrl: string;
  cookieSecure: boolean;
  sessionCookieName: string;
  downloadTtlSeconds: number;
  downloadTtlSource: "database" | "default";
  downloadMode: "proxy" | "redirect";
  downloadModeSource: "database" | "env";
  /** `STORE_DOWNLOAD_MODE`; what "跟随环境变量" returns to. */
  seedDownloadMode: "proxy" | "redirect";
  /** What the row itself pins, or null when it follows the seed. */
  downloadModeOverride: "proxy" | "redirect" | null;
  rateLimits: RateLimitRowView[];
  /** Addresses derived from `publicUrl`; shown so the operator sees the blast radius. */
  derived: { callbackUrl: string; webhookUrl: string; setupUrl: string };
  updatedAt: string | null;
  updatedBy: { id: string; username: string; displayName: string | null } | null;
  /**
   * `host[:port]` this console request arrived on, when the caller could determine it.
   * Compared against the effective public URL by the page: a mismatch is exactly the
   * "login does nothing" symptom, and only the host is compared (a scheme change is a
   * legitimate, deliberate operation).
   */
  requestHost: string | null;
  warnings: string[];
};

export type Actor = { adminId: string; ip?: string | null };

/** Where the current console request arrived, for the "生效地址 ≠ 访问地址" warning. */
export type SaveContext = {
  /** e.g. `https://store.example.com` — the origin of the request doing the save. */
  requestOrigin: string | null;
  requestProtocol: "http:" | "https:" | null;
  /** `host[:port]` of the same request, echoed back into the view. */
  requestHost?: string | null;
};

function rateLimitRows(runtime: RuntimeConfig, row: StoredRow | null): RateLimitRowView[] {
  const overrides = row?.rateLimits ?? {};

  return RATE_LIMIT_CHANNELS.map((channel) => {
    const stored = overrides[channel] ?? null;
    const checked = stored ? readStoredOverride(channel, stored) : null;
    const effectiveRule = runtime.rateLimits[channel];
    const effective = `${effectiveRule.limit}/${effectiveRule.windowSeconds}`;

    // Which layer is answering right now: the row, the channel's env var, or the built-in.
    const envSet = Boolean(process.env[RATE_LIMIT_ENV[channel]]?.trim());
    const source: RateLimitRowView["source"] = checked?.ok
      ? "database"
      : envSet
        ? "env"
        : "default";

    return {
      channel,
      override: stored,
      effective,
      source,
      invalidReason: checked && !checked.ok ? checked.reason : null,
    };
  });
}

type StoredRow = {
  publicUrl: string | null;
  downloadTtlSeconds: number | null;
  downloadMode: string | null;
  rateLimits: Record<string, string> | null;
  updatedAt: Date;
  updatedByAdminId: string | null;
};

async function readStoredRow(db: Db): Promise<StoredRow | null> {
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
    .where(eq(storeSettings.id, SINGLETON_ID))
    .limit(1);
  return row ?? null;
}

async function loadUpdatedBy(
  db: Db,
  adminId: string | null,
): Promise<StoreSettingsView["updatedBy"]> {
  if (!adminId) return null;
  const [admin] = await db
    .select({
      id: adminAccounts.id,
      username: adminAccounts.username,
      displayName: adminAccounts.displayName,
    })
    .from(adminAccounts)
    .where(eq(adminAccounts.id, adminId))
    .limit(1);
  return admin ?? null;
}

/** The pinned mode, or `null` when the row follows the seed (or holds something unreadable). */
function readModeOverride(row: StoredRow | null): "proxy" | "redirect" | null {
  const stored = row?.downloadMode?.trim().toLowerCase();
  return stored === "proxy" || stored === "redirect" ? stored : null;
}

export async function getStoreSettingsView(  db: Db,
  options: { requestHost?: string | null } = {},
): Promise<StoreSettingsView> {
  const config = getConfig();
  // Fresh on purpose: this page must never show a value the process has not picked up yet.
  const runtime = await getRuntimeConfig(db, { fresh: true });
  const row = await readStoredRow(db);

  return {
    publicUrl: runtime.publicUrl,
    publicUrlSource: runtime.publicUrlSource,
    seedPublicUrl: config.publicUrlSeed,
    cookieSecure: runtime.cookieSecure,
    sessionCookieName: cookieName(runtime.cookieSecure, "session"),
    downloadTtlSeconds: runtime.downloadTtlSeconds,
    downloadTtlSource: runtime.downloadTtlSource,
    downloadMode: runtime.downloadMode,
    downloadModeSource: runtime.downloadModeSource,
    seedDownloadMode: config.downloadMode,
    downloadModeOverride: readModeOverride(row),
    rateLimits: rateLimitRows(runtime, row),
    derived: {
      callbackUrl: sforumCallbackUrl(runtime.publicUrl),
      webhookUrl: githubWebhookUrl(runtime.publicUrl),
      setupUrl: githubSetupUrl(runtime.publicUrl),
    },
    updatedAt: runtime.updatedAt ? runtime.updatedAt.toISOString() : null,
    updatedBy: await loadUpdatedBy(db, runtime.updatedByAdminId),
    requestHost: options.requestHost ?? null,
    warnings: runtime.warnings,
  };
}

export type SaveSettingsInput = {
  publicUrl: string;
  downloadTtlSeconds: unknown;
  downloadMode: unknown;
  rateLimits: unknown;
  confirmOriginChange?: boolean;
  confirmInsecureTransition?: boolean;
};

export type SaveSettingsResult = {
  view: StoreSettingsView;
  /** True when the row changed; false means the form matched what was already stored. */
  changed: boolean;
};

/**
 * Validates, gates the two changes that can lock an operator out, writes, then re-reads with
 * `fresh` so the response proves the new value is already in effect for this process.
 */
export async function saveStoreSettings(
  db: Db,
  input: SaveSettingsInput,
  actor: Actor,
  context: SaveContext,
): Promise<SaveSettingsResult> {
  const config = getConfig();
  const production = config.nodeEnv === "production";

  const publicUrl = normalizePublicUrl(input.publicUrl);
  assertPublicUrlScheme(publicUrl, { production });
  const downloadTtlSeconds = parseDownloadTtl(input.downloadTtlSeconds);
  // `null` means "follow STORE_DOWNLOAD_MODE"; the effective value is resolved below.
  const downloadMode = parseDownloadMode(input.downloadMode);
  const overrides = parseRateLimitOverrides(input.rateLimits);

  const current = await getRuntimeConfig(db, { fresh: true });
  const nextOrigin = new URL(publicUrl).origin;
  const nextScheme = new URL(publicUrl).protocol;

  // Both gates are about *changing the address*, not about where the console happens to be
  // reached from: saving only a TTL from a second hostname must not demand a confirmation.
  const addressChanged = publicUrl !== current.publicUrl;

  // Changing the base address moves every redirect, callback and cookie name at once. It is a
  // legitimate operation (http → https behind a new proxy) but never an accident, so the
  // operator has to say yes to the specific consequences.
  if (addressChanged && context.requestOrigin && nextOrigin !== context.requestOrigin) {
    if (!input.confirmOriginChange) {
      throw new AdminError(
        "confirm_origin_change",
        409,
        `对外地址要改成 ${nextOrigin}，与当前访问的 ${context.requestOrigin} 不一致。` +
          "保存后所有 OAuth 回调、下载短链与会话 cookie 都会跟着改；论坛侧登记的回调地址也要同步更新。确认后请重新提交。",
      );
    }
  }

  // `__Host-` cookies cannot be written over plain http, so flipping to https while the
  // console is still served over http logs the operator out and keeps them out until TLS is
  // actually in place. Require an explicit acknowledgement.
  if (
    addressChanged &&
    nextScheme === "https:" &&
    context.requestProtocol === "http:" &&
    !input.confirmInsecureTransition
  ) {
    throw new AdminError(
      "confirm_insecure_transition",
      409,
      "当前请求走的是 http，但对外地址要设为 https：保存后 cookie 会切到 __Host- 前缀，" +
        "在 TLS 生效前你会被登出且无法重新登录。确认 TLS 已就位后再提交。",
    );
  }

  const row = await readStoredRow(db);
  const previous = {
    publicUrl: current.publicUrl,
    downloadTtlSeconds: current.downloadTtlSeconds,
    downloadMode: current.downloadMode,
    rateLimits: row?.rateLimits ?? {},
  };

  const changes = diffSettings(previous, {
    publicUrl,
    downloadTtlSeconds,
    downloadMode: downloadMode ?? config.downloadMode,
    rateLimits: overrides,
  });

  // Pinning a mode that already matches the seed changes nothing the operator can observe, but
  // it does change what a future env edit would do — so it is still a write, and still audited.
  const previousPin = readModeOverride(row);
  const pinChanged = previousPin !== downloadMode;
  if (pinChanged) {
    changes.push({
      key: "downloadMode.pinned",
      from: previousPin,
      to: downloadMode,
    });
  }

  if (changes.length > 0) {
    const values = {
      // Do not pin the seed: a row that merely repeats `STORE_PUBLIC_URL` would silently stop
      // following it, so only a *different* address is stored. Same rule the diff applies —
      // an unchanged value must not become a new source of truth.
      publicUrl: publicUrl === config.publicUrlSeed ? null : publicUrl,
      downloadTtlSeconds,
      // `null` is meaningful here (follow the env seed) and is exactly what the "跟随环境变量"
      // option sends; only an explicit pick pins the row.
      downloadMode,
      rateLimits: overrides,
      updatedAt: new Date(),
      updatedByAdminId: actor.adminId,
    };
    if (row) {
      await db.update(storeSettings).set(values).where(eq(storeSettings.id, SINGLETON_ID));
    } else {
      await db.insert(storeSettings).values({ id: SINGLETON_ID, ...values });
    }

    // This is the "立即生效" half: drop the cache, then re-read so the very next request in
    // this process (and the response below) sees the new value.
    invalidateRuntimeConfig();

    await recordAudit(db, {
      actorAdminId: actor.adminId,
      action: "admin.settings.updated",
      targetType: "store_settings",
      targetId: SINGLETON_ID,
      details: { changes },
      ip: actor.ip ?? null,
    });
  }

  const view = await getStoreSettingsView(db, { requestHost: context.requestHost ?? null });
  return { view, changed: changes.length > 0 };
}

/** Only the keys that actually moved — an unchanged form must not produce an audit line. */
function diffSettings(
  previous: {
    publicUrl: string;
    downloadTtlSeconds: number;
    downloadMode: "proxy" | "redirect";
    rateLimits: Record<string, string>;
  },
  next: {
    publicUrl: string;
    downloadTtlSeconds: number | null;
    downloadMode: "proxy" | "redirect";
    rateLimits: Record<string, string>;
  },
): Array<{ key: string; from: unknown; to: unknown }> {
  const changes: Array<{ key: string; from: unknown; to: unknown }> = [];
  const nextTtl = next.downloadTtlSeconds ?? DEFAULT_DOWNLOAD_TTL_SECONDS;

  if (previous.publicUrl !== next.publicUrl) {
    changes.push({ key: "publicUrl", from: previous.publicUrl, to: next.publicUrl });
  }
  if (previous.downloadTtlSeconds !== nextTtl) {
    changes.push({
      key: "downloadTtlSeconds",
      from: previous.downloadTtlSeconds,
      to: nextTtl,
    });
  }
  if (previous.downloadMode !== next.downloadMode) {
    changes.push({
      key: "downloadMode",
      from: previous.downloadMode,
      to: next.downloadMode,
    });
  }
  for (const channel of RATE_LIMIT_CHANNELS) {
    const from = previous.rateLimits[channel] ?? null;
    const to = next.rateLimits[channel] ?? null;
    if (from !== to) changes.push({ key: `rateLimits.${channel}`, from, to });
  }
  return changes;
}

/** Drops the row: every key returns to the env seed / built-in default. */
export async function clearStoreSettings(db: Db, actor: Actor): Promise<StoreSettingsView> {
  const row = await readStoredRow(db);
  if (row) {
    await db.delete(storeSettings).where(eq(storeSettings.id, SINGLETON_ID));
    invalidateRuntimeConfig();

    await recordAudit(db, {
      actorAdminId: actor.adminId,
      action: "admin.settings.reset",
      targetType: "store_settings",
      targetId: SINGLETON_ID,
      details: {
        publicUrl: row.publicUrl,
        downloadTtlSeconds: row.downloadTtlSeconds,
        rateLimits: row.rateLimits,
      },
      ip: actor.ip ?? null,
    });
  }
  return getStoreSettingsView(db);
}
