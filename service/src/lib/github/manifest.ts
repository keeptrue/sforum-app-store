import { createHash } from "node:crypto";

import { AdminError } from "@/lib/admin/errors";
import { signPayload, verifySignature } from "@/lib/crypto";

import { SLUG_PATTERN } from "./app-config";

/**
 * GitHub App Manifest flow — register the App from our console instead of by hand.
 *
 * Why it exists: the manual path asks an operator to copy four values across two windows
 * (App ID, slug, webhook secret, PEM) and to re-type three addresses. Three of those steps
 * fail silently rather than loudly — a slug typo only 404s on the install page, a secret that
 * differs by one character only shows up as `401 invalid_signature` on a delivery, and a
 * missing `repository` subscription just stops updating names. GitHub's own answer is the
 * manifest handshake: we POST a preconfigured manifest, the person confirms a name, and
 * GitHub hands back `id` + `slug` + `pem` + `webhook_secret` for a temporary `code`.
 *
 * Three facts from the protocol that shape everything here:
 *
 * 1. The handshake must finish within an hour and the `code` is single use.
 * 2. `POST /app-manifests/{code}/conversions` is *not* authenticated — the code is the
 *    credential. That is why the state below is bound to an admin session: without it, anyone
 *    who intercepted the callback could write an App into the console.
 * 3. It always creates a *new* App. There is no way to adopt an existing one, so the console
 *    path replaces the stored configuration rather than merging into it.
 *
 * Reference: docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */

/** GitHub's own deadline for the handshake; our state must not outlive it. */
export const MANIFEST_STATE_TTL_SECONDS = 60 * 60;

export const GITHUB_DOT_COM_API = "https://api.github.com";
const GITHUB_DOT_COM_WEB = "https://github.com";

/**
 * The two things the App must be able to do, and nothing else: read release assets and read
 * the workflow run behind a release. `administration` is deliberately absent — the store
 * never writes to a repository.
 */
export const MANIFEST_PERMISSIONS = {
  contents: "read",
  metadata: "read",
  actions: "read",
} as const;

/**
 * `repository` is in the list on purpose: without it a rename, a transfer or a switch to
 * private is silent — the webhook simply stops arriving and the local mirror keeps the old
 * name. See `knowledge/decisions/2026-10-25-github-repo-binding.md`.
 *
 * `installation` and `installation_repositories` are deliberately **absent**. GitHub always
 * delivers them to a GitHub App (they are part of the installation lifecycle, not something
 * you opt into), and the manifest validator rejects them outright:
 *
 *   Error  Default events unsupported: installation and installation_repositories
 *   Error  Default events are not supported by permissions: installation and installation_repositories
 *
 * The webhook handler still receives and handles both — dropping them here changes nothing
 * about delivery, only about what the manifest may name.
 *
 * `push` is subscribed for one reason: a `brand/` edit that never became a release. It is the
 * noisiest subscription the App has, so the webhook route drops every delivery that did not
 * move the default branch into a `brand/` path before it stores anything
 * (`lib/github/push-filter.ts`).
 */
export const MANIFEST_EVENTS = ["release", "repository", "push"] as const;

export type GithubAppManifest = {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  setup_url: string;
  public: true;
  default_permissions: Record<string, string>;
  default_events: string[];
  request_oauth_on_install: false;
};

export type ManifestState = {
  adminId: string;
  nonce: string;
  exp: number;
};

/** Same signed-payload shape as `install-state.ts`, different payload: this one names an admin. */
export function encodeManifestState(payload: ManifestState, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signPayload(encoded, secret)}`;
}

export function decodeManifestState(value: string, secret: string): ManifestState | null {
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const encoded = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!verifySignature(encoded, signature, secret)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const input = payload as Record<string, unknown>;
  if (
    typeof input.adminId !== "string" ||
    !input.adminId ||
    typeof input.nonce !== "string" ||
    !input.nonce ||
    typeof input.exp !== "number" ||
    input.exp * 1000 <= Date.now()
  ) {
    return null;
  }
  return { adminId: input.adminId, nonce: input.nonce, exp: input.exp };
}

/**
 * The callback's state check, in one place because getting it wrong is invisible until a real
 * round trip.
 *
 * The cookie holds the signed token *we* issued; the query string must carry that same token
 * back. Comparing the decoded `nonce` against the query — the shape this started with — can
 * never match: the query carries the whole signed token, not the nonce inside it, so every
 * callback reported `reason=state`. Both halves are needed: the signature proves we minted it,
 * the equality proves this callback belongs to *this* browser's flow (otherwise an attacker's
 * `code` could be completed by an admin's cookie).
 */
export function verifyManifestState(
  cookieValue: string | null,
  queryState: string | null,
  secret: string,
): ManifestState | null {
  if (!cookieValue || !queryState) return null;
  if (cookieValue !== queryState) return null;
  return decodeManifestState(cookieValue, secret);
}

/**
 * The App name is prefilled, not fixed: GitHub shows it in an editable field and derives the
 * slug from whatever the person leaves there, so a collision with another deployment's name
 * is something they can fix on that page. The suggestion is host-derived so two stores on the
 * same GitHub account do not fight over one name.
 */
export function defaultAppName(publicUrl: string): string {
  const host = new URL(publicUrl).hostname;
  const label = (host.split(".")[0] ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const trimmed = label.replace(/^-+|-+$/g, "");
  const suffix =
    trimmed.length >= 3 && trimmed.length <= 12
      ? trimmed
      : createHash("sha256").update(host).digest("hex").slice(0, 6);
  return `sforum-store-${suffix}`;
}

export function manifestCallbackUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/api/github/manifest/callback`;
}

export function buildGithubAppManifest(input: {
  name: string;
  publicUrl: string;
  webhookUrl: string;
  setupUrl: string;
  redirectUrl: string;
}): GithubAppManifest {
  return {
    name: input.name,
    url: input.publicUrl,
    hook_attributes: { url: input.webhookUrl, active: true },
    redirect_url: input.redirectUrl,
    setup_url: input.setupUrl,
    // Not cosmetic: a *private* App can only be installed by the account that owns it, and
    // developers install this one on their own repositories. Private would break binding.
    public: true,
    default_permissions: { ...MANIFEST_PERMISSIONS },
    default_events: [...MANIFEST_EVENTS],
    request_oauth_on_install: false,
  };
}

/**
 * The form target. `owner` switches from "my account" to an organization; GitHub has no
 * single endpoint that covers both.
 */
export function manifestStartUrl(webHost: string, state: string, owner?: string | null): string {
  const base = webHost.replace(/\/+$/, "");
  const path = owner
    ? `/organizations/${encodeURIComponent(owner)}/settings/apps/new`
    : "/settings/apps/new";
  const url = new URL(`${base}${path}`);
  url.searchParams.set("state", state);
  return url.toString();
}

export function isGithubDotCom(apiBaseUrl: string): boolean {
  return apiBaseUrl.replace(/\/+$/, "") === GITHUB_DOT_COM_API;
}

/** `https://api.github.com` → `https://github.com`; a GHES `…/api/v3` drops the suffix. */
export function webHostFor(apiBaseUrl: string): string {
  const normalized = apiBaseUrl.replace(/\/+$/, "");
  if (normalized === GITHUB_DOT_COM_API) return GITHUB_DOT_COM_WEB;
  const url = new URL(normalized);
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/v3$/, "");
  return `${url.origin}${path}`;
}

export function manifestConversionsUrl(apiBaseUrl: string, code: string): string {
  return `${apiBaseUrl.replace(/\/+$/, "")}/app-manifests/${encodeURIComponent(code)}/conversions`;
}

export type ManifestConversion = {
  appId: number;
  slug: string;
  pem: string;
  webhookSecret: string;
  htmlUrl: string | null;
  owner: string | null;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Step 3 of the handshake. Validates every field it needs before the caller writes anything:
 * a half-valid conversion would leave a row that cannot sign a JWT.
 */
export async function exchangeManifestCode(input: {
  apiBaseUrl: string;
  code: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<ManifestConversion> {
  const code = input.code.trim();
  if (!code) {
    throw new AdminError("manifest_missing_code", 400, "回调里没有 code，这次创建无法完成");
  }

  const fetchImpl: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000);

  let response: Response;
  try {
    response = await fetchImpl(manifestConversionsUrl(input.apiBaseUrl, code), {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new AdminError(
      "manifest_exchange_failed",
      502,
      aborted
        ? "换取 App 凭据超时：检查出站网络能否访问 GitHub API"
        : "换取 App 凭据失败：出站网络不可达",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // 404 is the common one: the code is single use and expires after an hour.
    throw new AdminError(
      "manifest_exchange_failed",
      502,
      response.status === 404
        ? "这个 code 已经用过或已过期（GitHub 只允许兑换一次，且一小时内有效），请重新创建一次"
        : `GitHub 拒绝了这次换取（HTTP ${response.status}）`,
    );
  }

  const body: unknown = await response.json().catch(() => null);
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  const appId = typeof record.id === "number" ? record.id : Number(record.id);
  if (!Number.isSafeInteger(appId) || appId <= 0) {
    throw new AdminError("manifest_invalid_response", 502, "GitHub 返回的 App ID 不可用");
  }

  const slug = typeof record.slug === "string" ? record.slug.trim() : "";
  if (!SLUG_PATTERN.test(slug)) {
    throw new AdminError("manifest_invalid_response", 502, "GitHub 返回的 slug 不可用");
  }

  const pem = typeof record.pem === "string" ? record.pem : "";
  if (!pem.includes("PRIVATE KEY")) {
    throw new AdminError("manifest_invalid_response", 502, "GitHub 没有返回私钥，配置不完整");
  }

  // GitHub generates the webhook secret during the handshake; we never invent one, and we
  // never display it.
  const webhookSecret =
    typeof record.webhook_secret === "string" ? record.webhook_secret.trim() : "";
  if (webhookSecret.length < 16) {
    throw new AdminError("manifest_invalid_response", 502, "GitHub 没有返回可用的 webhook secret");
  }

  const ownerRecord =
    record.owner && typeof record.owner === "object"
      ? (record.owner as Record<string, unknown>)
      : null;

  return {
    appId,
    slug,
    pem,
    webhookSecret,
    htmlUrl: typeof record.html_url === "string" ? record.html_url : null,
    owner: ownerRecord && typeof ownerRecord.login === "string" ? ownerRecord.login : null,
  };
}
