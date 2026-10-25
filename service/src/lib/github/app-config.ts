import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

import { asc, eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import { githubAppConfig, githubAppPrivateKeys } from "@/db/schema";
import { AdminError } from "@/lib/admin/errors";
import { getConfig, type GithubConfig, type StoreConfig } from "@/lib/config";
import { getRuntimeConfig } from "@/lib/settings/runtime";
import { decryptSecret, encryptSecret, type Keyring } from "@/lib/crypto";
import { recordAudit } from "@/lib/moderation/events";
import { GithubAppClient } from "./client";

/**
 * GitHub App credentials live in the database, not in env (2026-10-25).
 *
 * Why the move: the App id, slug, webhook secret and signing keys are per-deployment
 * configuration that an operator changes at runtime (rotating a webhook secret used to mean
 * editing `.env` and restarting the web and worker processes in lockstep). They are now one
 * console form. What stays in env is `STORE_SECRET_KEYS`: that is the keyring, the root that
 * encrypts these values, not a value the console may hand out.
 *
 * `GITHUB_APP_ID` / `GITHUB_APP_SLUG` / `GITHUB_WEBHOOK_SECRET` / `GITHUB_APP_PRIVATE_KEYS` /
 * `GITHUB_API_BASE_URL` are gone. A deployment that still has them must re-enter the App in
 * the console; env values are ignored so there is exactly one source of truth.
 */

/** The single row. `github_app_config_singleton_idx` makes a second one impossible. */
const SINGLETON_ID = "default";

/**
 * Short-lived process cache. The web process and the worker are separate, so a console write
 * reaches the other side within this window instead of instantly; every reader path is a
 * single-row lookup, and this only exists so a download or a webhook does not re-read and
 * re-decrypt the private key on every request.
 */
const CACHE_TTL_MS = 15_000;

/**
 * `signature` is derived from the row's `updated_at` and its key ids. When it is unchanged the
 * previous `GithubConfig` object is handed back by identity, which is what lets
 * `GithubAppClient` keep its installation-token cache: a new object would mean a new client and
 * a re-mint on every download.
 */
type CacheEntry = {
  config: GithubConfig | null;
  signature: string;
  expiresAt: number;
};
let cache: CacheEntry | null = null;

export function invalidateGithubConfigCache(): void {
  cache = null;
}

/**
 * A stored App that cannot be turned into a usable client: no signing key, or a ciphertext
 * the current keyring cannot open. Distinct from "not configured" on purpose — reporting it
 * as absent would silently close the webhook and the download proxy with no clue why.
 */
export class GithubAppConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GithubAppConfigError";
    this.code = code;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ReadResult = { config: GithubConfig | null; signature: string };

async function readConfig(db: Db, keyring: Keyring): Promise<ReadResult> {
  const [row] = await db
    .select()
    .from(githubAppConfig)
    .where(eq(githubAppConfig.id, SINGLETON_ID))
    .limit(1);
  if (!row) return { config: null, signature: "none" };

  // Oldest first: `GithubAppClient` signs with the *last* key it sees, so appending is how a
  // rotation promotes the new key without touching the old one.
  const keys = await db
    .select({
      appKeyId: githubAppPrivateKeys.appKeyId,
      ciphertext: githubAppPrivateKeys.ciphertext,
    })
    .from(githubAppPrivateKeys)
    .where(eq(githubAppPrivateKeys.configId, row.id))
    .orderBy(asc(githubAppPrivateKeys.createdAt), asc(githubAppPrivateKeys.appKeyId));

  if (keys.length === 0) {
    throw new GithubAppConfigError(
      "github_config_incomplete",
      "GitHub App 已保存但没有任何签名私钥：请在后台上传一把 private key。",
    );
  }

  const privateKeys = new Map<string, string>();
  for (const key of keys) {
    try {
      privateKeys.set(key.appKeyId, decryptSecret(key.ciphertext, keyring));
    } catch (error) {
      throw new GithubAppConfigError(
        "github_config_unreadable",
        `私钥 ${key.appKeyId} 无法解密（${describe(error)}）：STORE_SECRET_KEYS 里缺少对应的 kid。`,
      );
    }
  }

  let webhookSecret: string;
  try {
    webhookSecret = decryptSecret(row.webhookSecretCiphertext, keyring);
  } catch (error) {
    throw new GithubAppConfigError(
      "github_config_unreadable",
      `webhook secret 无法解密（${describe(error)}）：STORE_SECRET_KEYS 里缺少对应的 kid。`,
    );
  }

  return {
    signature: `${row.updatedAt.getTime()}:${keys.map((key) => key.appKeyId).join(",")}`,
    config: {
      appId: row.appId,
      slug: row.slug,
      webhookSecret,
      privateKeys,
      apiBaseUrl: row.apiBaseUrl,
    },
  };
}

/**
 * Reader used by every runtime path (webhook, install flow, sync jobs, download proxy).
 * `null` means "no App configured"; a stored-but-broken App throws `GithubAppConfigError`.
 */
export async function loadGithubConfig(
  db: Db,
  options: { fresh?: boolean } = {},
): Promise<GithubConfig | null> {
  const now = Date.now();
  if (!options.fresh && cache && cache.expiresAt > now) return cache.config;

  const read = await readConfig(db, getConfig().keyring);
  const reusable = cache?.signature === read.signature ? cache.config : read.config;
  cache = { config: reusable, signature: read.signature, expiresAt: now + CACHE_TTL_MS };
  return reusable;
}

/** Convenience for callers that cannot proceed without an App. */
export async function requireGithubConfig(db: Db): Promise<GithubConfig> {
  const config = await loadGithubConfig(db);
  if (!config) {
    throw new GithubAppConfigError(
      "github_not_configured",
      "GitHub App 尚未配置：请在后台「GitHub App」里填写并保存。",
    );
  }
  return config;
}

// --- console ---------------------------------------------------------------------------

export type GithubAppKeyView = {
  appKeyId: string;
  fingerprint: string;
  createdAt: string;
  /** True for the key that signs right now (the newest row). */
  signing: boolean;
};

export type GithubAppView = {
  configured: boolean;
  appId: number | null;
  slug: string | null;
  apiBaseUrl: string;
  webhookSecretSet: boolean;
  keys: GithubAppKeyView[];
  lastVerifiedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
  /** Set when a stored App cannot be decrypted; the form still renders so it can be fixed. */
  readError: string | null;
  /** Where GitHub should deliver events; derived from `STORE_PUBLIC_URL`. */
  webhookUrl: string;
  /** Where GitHub sends the browser back after an installation; derived, not stored. */
  setupUrl: string;
  /** `null` until a slug is stored. */
  installUrl: string | null;
};

/** Exported so 系统设置 can show the same address this module derives, not a copy of it. */
export function githubWebhookUrl(publicUrl: string): string {
  return `${publicUrl}/api/github/webhook`;
}

/**
 * The App's *Setup URL* (not its Callback URL): GitHub redirects here after an installation
 * with `installation_id` + our `state`. One derivation, so the address the console shows and
 * the one `/api/github/setup` answers on cannot drift.
 */
export function githubSetupUrl(publicUrl: string): string {
  return `${publicUrl}/api/github/setup`;
}

export async function getGithubAppView(db: Db): Promise<GithubAppView> {
  const store = getConfig();
  // The effective public URL, not the boot seed: the webhook and setup addresses this page
  // tells the operator to paste into GitHub must match what the service actually serves.
  const { publicUrl } = await getRuntimeConfig(db);
  const [row] = await db
    .select()
    .from(githubAppConfig)
    .where(eq(githubAppConfig.id, SINGLETON_ID))
    .limit(1);

  if (!row) {
    return {
      configured: false,
      appId: null,
      slug: null,
      apiBaseUrl: "https://api.github.com",
      webhookSecretSet: false,
      keys: [],
      lastVerifiedAt: null,
      lastError: null,
      updatedAt: null,
      readError: null,
      webhookUrl: githubWebhookUrl(publicUrl),
      setupUrl: githubSetupUrl(publicUrl),
      installUrl: null,
    };
  }

  const keys = await db
    .select({
      appKeyId: githubAppPrivateKeys.appKeyId,
      fingerprint: githubAppPrivateKeys.fingerprint,
      createdAt: githubAppPrivateKeys.createdAt,
    })
    .from(githubAppPrivateKeys)
    .where(eq(githubAppPrivateKeys.configId, row.id))
    .orderBy(asc(githubAppPrivateKeys.createdAt), asc(githubAppPrivateKeys.appKeyId));

  let readError: string | null = null;
  try {
    await readConfig(db, store.keyring);
  } catch (error) {
    readError = describe(error);
  }

  return {
    configured: true,
    appId: row.appId,
    slug: row.slug,
    apiBaseUrl: row.apiBaseUrl,
    // Never the secret itself: whether one exists is all the form may know.
    webhookSecretSet: Boolean(row.webhookSecretCiphertext),
    keys: keys.map((key, index) => ({
      appKeyId: key.appKeyId,
      fingerprint: key.fingerprint,
      createdAt: key.createdAt.toISOString(),
      signing: index === keys.length - 1,
    })),
    lastVerifiedAt: row.lastVerifiedAt ? row.lastVerifiedAt.toISOString() : null,
    lastError: row.lastError,
    updatedAt: row.updatedAt.toISOString(),
    readError,
    webhookUrl: githubWebhookUrl(publicUrl),
    setupUrl: githubSetupUrl(publicUrl),
    installUrl: `https://github.com/apps/${row.slug}/installations/new`,
  };
}

export type ParsedPrivateKey = { pem: string; fingerprint: string; appKeyId: string };

/**
 * PEM in, identity out. The `kid` GitHub shows on an App key is not derivable from the file,
 * so the fingerprint of the public key is what identifies it — the console labels keys by it
 * and never renders key material.
 */
export function parsePrivateKeyPem(raw: string): ParsedPrivateKey {
  // Accept a JSON-escaped paste (`\n` literals) and CRLF files, which is how keys arrive when
  // they are copied out of a JSON secret store or a Windows editor.
  const pem = raw
    .replace(/\\r\\n|\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!pem) {
    throw new AdminError("invalid_private_key", 400, "private key 不能为空");
  }
  if (!/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(pem)) {
    throw new AdminError(
      "invalid_private_key",
      400,
      "这不是 PEM 私钥：请粘贴 GitHub App 页面上生成的 .private-key.pem 内容",
    );
  }

  let key;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch (error) {
    throw new AdminError(
      "invalid_private_key",
      400,
      `private key 无法解析（${describe(error)}）：需要未加密的 PKCS#8 或 PKCS#1 PEM`,
    );
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new AdminError(
      "invalid_private_key",
      400,
      `private key 必须是 RSA（当前是 ${key.asymmetricKeyType ?? "unknown"}）`,
    );
  }

  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const fingerprint = createHash("sha256").update(spki).digest("hex");

  return {
    pem: `${pem}\n`,
    fingerprint,
    appKeyId: fingerprint.slice(0, 12),
  };
}

export type GithubAppInput = {
  appId: number | string;
  slug: string;
  apiBaseUrl?: string;
  /** Empty/omitted on update keeps the stored secret. */
  webhookSecret?: string;
  /** PEM; omitted on update keeps the current keys. */
  privateKeyPem?: string;
};

/** Exported so the manifest flow validates GitHub's answer with the same rule the form uses. */
export const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const MIN_WEBHOOK_SECRET = 16;
const MAX_WEBHOOK_SECRET = 256;

function validateApiBaseUrl(raw: string | undefined, production: boolean): string {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return "https://api.github.com";

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AdminError("invalid_api_base_url", 400, "api_base_url 不是合法 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AdminError("invalid_api_base_url", 400, "api_base_url 只能用 http 或 https");
  }
  const local =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "::1";
  if (production && url.protocol !== "https:" && !local) {
    throw new AdminError("invalid_api_base_url", 400, "生产环境 api_base_url 必须使用 https");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export function validateGithubAppInput(
  input: GithubAppInput,
  options: { production: boolean; creating: boolean },
): {
  appId: number;
  slug: string;
  apiBaseUrl: string;
  webhookSecret: string | null;
  privateKey: ParsedPrivateKey | null;
} {
  const appId =
    typeof input.appId === "number" ? input.appId : Number(String(input.appId ?? "").trim());
  if (!Number.isSafeInteger(appId) || appId <= 0) {
    throw new AdminError("invalid_app_id", 400, "app_id 必须是正整数（GitHub App 的 App ID）");
  }

  const slug = (input.slug ?? "").trim();
  if (!SLUG_PATTERN.test(slug)) {
    throw new AdminError(
      "invalid_slug",
      400,
      "slug 是 App 的 URL 名（github.com/apps/<slug>），只能用字母、数字与连字符",
    );
  }

  const apiBaseUrl = validateApiBaseUrl(input.apiBaseUrl, options.production);

  const rawSecret = (input.webhookSecret ?? "").trim();
  let webhookSecret: string | null = null;
  if (rawSecret) {
    if (rawSecret.length < MIN_WEBHOOK_SECRET) {
      throw new AdminError(
        "invalid_webhook_secret",
        400,
        `webhook secret 至少 ${MIN_WEBHOOK_SECRET} 字符（GitHub 建议 32+，用 openssl rand -hex 32 生成）`,
      );
    }
    if (rawSecret.length > MAX_WEBHOOK_SECRET) {
      throw new AdminError(
        "invalid_webhook_secret",
        400,
        `webhook secret 最多 ${MAX_WEBHOOK_SECRET} 字符`,
      );
    }
    webhookSecret = rawSecret;
  } else if (options.creating) {
    throw new AdminError(
      "missing_webhook_secret",
      400,
      "首次配置必须填写 webhook secret：没有它 webhook 一律验签失败",
    );
  }

  const rawKey = input.privateKeyPem ?? "";
  const privateKey = rawKey.trim() ? parsePrivateKeyPem(rawKey) : null;
  if (!privateKey && options.creating) {
    throw new AdminError(
      "missing_private_key",
      400,
      "首次配置必须上传 private key：没有它拿不到 App JWT",
    );
  }

  return { appId, slug, apiBaseUrl, webhookSecret, privateKey };
}

type Actor = { adminId: string; ip?: string | null };

async function insertKey(
  db: Db,
  store: StoreConfig,
  configId: string,
  key: ParsedPrivateKey,
): Promise<void> {
  const ciphertext = encryptSecret(key.pem, store.keyring);
  try {
    await db.insert(githubAppPrivateKeys).values({
      configId,
      appKeyId: key.appKeyId,
      fingerprint: key.fingerprint,
      ciphertext,
      keyringKid: ciphertext.split(".")[1] ?? "unknown",
    });
  } catch (error) {
    // Same key pasted twice: the fingerprint *is* the id, so this is a duplicate, not a crash.
    if (isUniqueViolation(error)) {
      throw new AdminError(
        "key_exists",
        409,
        `这把私钥已经在上面的列表里了（${key.appKeyId}）。`,
      );
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown, depth = 0): boolean {
  if (typeof error !== "object" || error === null || depth > 3) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (candidate.code === "23505") return true;
  return isUniqueViolation(candidate.cause, depth + 1);
}

export async function saveGithubAppConfig(
  db: Db,
  store: StoreConfig,
  input: GithubAppInput,
  actor: Actor,
): Promise<{ addedKey: string | null }> {
  const [existing] = await db
    .select({ id: githubAppConfig.id })
    .from(githubAppConfig)
    .where(eq(githubAppConfig.id, SINGLETON_ID))
    .limit(1);

  const value = validateGithubAppInput(input, {
    production: store.nodeEnv === "production",
    creating: !existing,
  });

  if (existing) {
    const patch: Record<string, unknown> = {
      appId: value.appId,
      slug: value.slug,
      apiBaseUrl: value.apiBaseUrl,
      updatedAt: new Date(),
    };
    if (value.webhookSecret) {
      const ciphertext = encryptSecret(value.webhookSecret, store.keyring);
      patch.webhookSecretCiphertext = ciphertext;
      patch.webhookSecretKeyringKid = ciphertext.split(".")[1] ?? "unknown";
    }
    // A saved change invalidates the last verification: the console must not keep showing a
    // green "已连通" next to an app id that was never checked.
    patch.lastVerifiedAt = null;
    patch.lastError = null;

    await db
      .update(githubAppConfig)
      .set(patch)
      .where(eq(githubAppConfig.id, SINGLETON_ID));
  } else {
    const ciphertext = encryptSecret(value.webhookSecret!, store.keyring);
    await db.insert(githubAppConfig).values({
      id: SINGLETON_ID,
      appId: value.appId,
      slug: value.slug,
      apiBaseUrl: value.apiBaseUrl,
      webhookSecretCiphertext: ciphertext,
      webhookSecretKeyringKid: ciphertext.split(".")[1] ?? "unknown",
    });
  }

  if (value.privateKey) {
    await insertKey(db, store, SINGLETON_ID, value.privateKey);
  }

  invalidateGithubConfigCache();

  await recordAudit(db, {
    actorAdminId: actor.adminId,
    action: existing ? "admin.github_app.updated" : "admin.github_app.created",
    targetType: "github_app",
    targetId: String(value.appId),
    // Never the secret, never the key: what changed, not what it is.
    details: {
      appId: value.appId,
      slug: value.slug,
      apiBaseUrl: value.apiBaseUrl,
      rotatedWebhookSecret: Boolean(value.webhookSecret),
      addedKey: value.privateKey?.appKeyId ?? null,
    },
    ip: actor.ip ?? null,
  });

  return { addedKey: value.privateKey?.appKeyId ?? null };
}

async function requireConfigRow(db: Db): Promise<{ id: string }> {
  const [row] = await db
    .select({ id: githubAppConfig.id })
    .from(githubAppConfig)
    .where(eq(githubAppConfig.id, SINGLETON_ID))
    .limit(1);
  if (!row) {
    throw new AdminError("github_not_configured", 404, "还没有配置 GitHub App");
  }
  return row;
}

export async function addGithubAppKey(
  db: Db,
  store: StoreConfig,
  input: { privateKeyPem: string },
  actor: Actor,
): Promise<{ appKeyId: string }> {
  const row = await requireConfigRow(db);
  const key = parsePrivateKeyPem(input.privateKeyPem ?? "");
  await insertKey(db, store, row.id, key);
  invalidateGithubConfigCache();

  await recordAudit(db, {
    actorAdminId: actor.adminId,
    action: "admin.github_app.key_added",
    targetType: "github_app",
    targetId: row.id,
    details: { appKeyId: key.appKeyId, fingerprint: key.fingerprint },
    ip: actor.ip ?? null,
  });

  return { appKeyId: key.appKeyId };
}

/**
 * Rotation is add-then-remove. The last key cannot be removed: an App with no signing key
 * cannot mint a JWT, so the whole integration would stop with no way back in through the
 * console's own "验证" button.
 */
export async function removeGithubAppKey(
  db: Db,
  appKeyId: string,
  actor: Actor,
): Promise<{ remaining: number }> {
  const row = await requireConfigRow(db);
  const keys = await db
    .select({ appKeyId: githubAppPrivateKeys.appKeyId })
    .from(githubAppPrivateKeys)
    .where(eq(githubAppPrivateKeys.configId, row.id));

  const target = keys.find((key) => key.appKeyId === appKeyId);
  if (!target) throw new AdminError("not_found", 404, "私钥不存在");
  if (keys.length <= 1) {
    throw new AdminError(
      "last_key",
      409,
      "不能删除最后一把私钥：先上传新的，再删旧的。",
    );
  }

  await db
    .delete(githubAppPrivateKeys)
    .where(eq(githubAppPrivateKeys.appKeyId, appKeyId));
  invalidateGithubConfigCache();

  await recordAudit(db, {
    actorAdminId: actor.adminId,
    action: "admin.github_app.key_removed",
    targetType: "github_app",
    targetId: row.id,
    details: { appKeyId, remaining: keys.length - 1 },
    ip: actor.ip ?? null,
  });

  return { remaining: keys.length - 1 };
}

/**
 * Removes the App configuration. Installations and synced repositories are untouched: they
 * are history, and re-adding the same App picks them straight back up.
 */
export async function clearGithubAppConfig(db: Db, actor: Actor): Promise<void> {
  const row = await requireConfigRow(db);
  await db.delete(githubAppConfig).where(eq(githubAppConfig.id, row.id));
  invalidateGithubConfigCache();

  await recordAudit(db, {
    actorAdminId: actor.adminId,
    action: "admin.github_app.removed",
    targetType: "github_app",
    targetId: row.id,
    details: null,
    ip: actor.ip ?? null,
  });
}

/**
 * Writes an App that GitHub just created for us (manifest flow).
 *
 * Replace, not merge: the handshake always produces a *new* App, and the previous App's
 * signing keys must not survive it. A key that can no longer mint a JWT for the stored App
 * would still render as a usable "备用" row — the console would be offering a rollback that
 * does not work. Deleting the row cascades its keys.
 *
 * Two audit rows when something is replaced (`removed` then `created`), so the trail shows
 * both halves without inventing a new action name.
 */
export async function replaceGithubAppFromManifest(
  db: Db,
  store: StoreConfig,
  input: { appId: number; slug: string; webhookSecret: string; privateKeyPem: string },
  actor: Actor,
): Promise<{ replacedAppId: number | null }> {
  const [existing] = await db
    .select({ appId: githubAppConfig.appId })
    .from(githubAppConfig)
    .where(eq(githubAppConfig.id, SINGLETON_ID))
    .limit(1);

  if (existing) {
    await db.delete(githubAppConfig).where(eq(githubAppConfig.id, SINGLETON_ID));
    invalidateGithubConfigCache();
    await recordAudit(db, {
      actorAdminId: actor.adminId,
      action: "admin.github_app.removed",
      targetType: "github_app",
      targetId: String(existing.appId),
      details: { via: "manifest", replacedBy: input.appId },
      ip: actor.ip ?? null,
    });
  }

  await saveGithubAppConfig(db, store, input, actor);
  return { replacedAppId: existing?.appId ?? null };
}

export type GithubVerifyResult = {
  ok: boolean;
  status: number | null;
  message: string;
  app?: { id: number; slug: string; name: string; owner: string | null };
};

/**
 * Identity probe: `GET /app` with an App JWT. It proves three things at once that a form
 * cannot — the app id exists, the private key is the matching one, and the stored slug is the
 * App's real slug (a wrong slug only fails later, as a 404 install page).
 *
 * A failure is recorded and reported, never enforced.
 */
export async function verifyGithubApp(
  db: Db,
  actor: Actor,
  options: { timeoutMs?: number } = {},
): Promise<GithubVerifyResult> {
  const store = getConfig();
  let config: GithubConfig | null;
  try {
    config = await loadGithubConfig(db, { fresh: true });
  } catch (error) {
    const message = describe(error);
    await recordVerification(db, actor, { ok: false, status: null, message });
    return { ok: false, status: null, message };
  }
  if (!config) {
    throw new AdminError("github_not_configured", 404, "还没有配置 GitHub App");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  const client = new GithubAppClient(config, {
    fetchImpl: (input, init) =>
      fetch(input, { ...init, signal: controller.signal }),
  });

  let result: GithubVerifyResult;
  try {
    const app = await client.getApp();
    const owner = app.owner?.login ?? null;
    if (app.slug !== config.slug) {
      result = {
        ok: false,
        status: 200,
        message: `App 可访问，但 slug 不匹配：GitHub 上是「${app.slug}」，后台存的是「${config.slug}」。安装链接会 404。`,
        app: { id: app.id, slug: app.slug, name: app.name, owner },
      };
    } else {
      result = {
        ok: true,
        status: 200,
        message: `已连通：${app.name}（${app.slug}${owner ? ` · ${owner}` : ""}）`,
        app: { id: app.id, slug: app.slug, name: app.name, owner },
      };
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    result = {
      ok: false,
      status: null,
      message: aborted
        ? "连接超时：检查出站网络能否访问 GitHub API"
        : `验证失败：${describe(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }

  await recordVerification(db, actor, result);
  return result;
}

async function recordVerification(
  db: Db,
  actor: Actor,
  result: GithubVerifyResult,
): Promise<void> {
  await db
    .update(githubAppConfig)
    .set({
      lastVerifiedAt: result.ok ? new Date() : null,
      lastError: result.ok ? null : result.message,
      updatedAt: new Date(),
    })
    .where(eq(githubAppConfig.id, SINGLETON_ID));

  await recordAudit(db, {
    actorAdminId: actor.adminId,
    action: "admin.github_app.verified",
    targetType: "github_app",
    targetId: SINGLETON_ID,
    details: { ok: result.ok, status: result.status, message: result.message },
    ip: actor.ip ?? null,
  });
}
