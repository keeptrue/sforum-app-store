import { MAX_IMAGE_BYTES, validateImage, type ImageMime } from "@/lib/storage/image";

/**
 * GitHub's social preview image, fetched once and stored as a content-addressed asset.
 *
 * GitHub exposes the preview only through the repository page: `og:image` points at
 * `repository-images.githubusercontent.com/<repo id>/<uuid>`. There is no REST field for it,
 * and the older `opengraph.githubassets.com/<hash>/<owner>/<repo>` endpoint now answers 429,
 * so the page HTML is the only reliable source. That makes this a deliberate, narrow
 * exception to "GitHub API only":
 *
 * - the URL is built from a `repo_id`-backed `full_name` in our own database, never from
 *   user input, so it cannot be pointed at an arbitrary host;
 * - only the `og:image` value is read, and only from `repository-images.githubusercontent.com`;
 * - both responses are read through a byte cap and a timeout;
 * - GHES deployments are skipped entirely (their web host is not `github.com`).
 *
 * Every failure is a normal state: the product simply has no preview and the UI falls back
 * to a letter tile. Nothing here throws.
 */

export const GITHUB_WEB_BASE = "https://github.com";
export const SOCIAL_PREVIEW_HOST = "repository-images.githubusercontent.com";

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = "sforum-app-store (+https://github.com/keeptrue/sforum)";

/** `owner/repo`, the shape GitHub uses for `full_name`. */
const FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;

/** `property` may come before or after `content`; both orders appear in GitHub's HTML. */
const OG_IMAGE_FIRST =
  /<meta\s+[^>]*?(?:property|name)=["']og:image["'][^>]*?content=["']([^"']+)["']/i;
const OG_IMAGE_LAST =
  /<meta\s+[^>]*?content=["']([^"']+)["'][^>]*?(?:property|name)=["']og:image["']/i;

export type SocialPreview = {
  bytes: Uint8Array;
  mime: ImageMime;
  width: number;
  height: number;
  /** The `repository-images` URL the bytes came from; stored for auditing, never published. */
  sourceUrl: string;
};

export type SocialPreviewFailure =
  | "ghes"
  | "invalid_repo_name"
  | "http_error"
  | "no_og_image"
  | "untrusted_host"
  | "too_large"
  | "unsupported_image"
  | "network";

export type SocialPreviewResult =
  | { ok: true; preview: SocialPreview }
  | { ok: false; reason: SocialPreviewFailure };

export type FetchSocialPreviewOptions = {
  /** `GithubConfig.apiBaseUrl`; anything but the public API means GHES and is skipped. */
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const PUBLIC_API_BASE = "https://api.github.com";

function fail(reason: SocialPreviewFailure): SocialPreviewResult {
  return { ok: false, reason };
}

/** Read at most `limit` bytes; a response that exceeds it is rejected, not truncated. */
async function readLimited(
  response: Response,
  limit: number,
): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function extractOgImage(html: string): string | null {
  const match = OG_IMAGE_FIRST.exec(html) ?? OG_IMAGE_LAST.exec(html);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

export async function fetchSocialPreview(
  repoFullName: string,
  options: FetchSocialPreviewOptions,
): Promise<SocialPreviewResult> {
  if (options.apiBaseUrl.replace(/\/+$/, "") !== PUBLIC_API_BASE) return fail("ghes");
  if (!FULL_NAME.test(repoFullName)) return fail("invalid_repo_name");

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = () => AbortSignal.timeout(timeoutMs);

  let page: Response;
  try {
    page = await fetchImpl(`${GITHUB_WEB_BASE}/${repoFullName}`, {
      method: "GET",
      redirect: "follow",
      headers: {
        accept: "text/html",
        "accept-language": "en",
        "user-agent": USER_AGENT,
      },
      signal: signal(),
    });
  } catch {
    return fail("network");
  }
  if (!page.ok) {
    // A private repository answers 404 to an anonymous page request: no preview, by design.
    await page.body?.cancel().catch(() => undefined);
    return fail("http_error");
  }

  const htmlBytes = await readLimited(page, MAX_HTML_BYTES);
  if (!htmlBytes) return fail("too_large");

  const ogImage = extractOgImage(Buffer.from(htmlBytes).toString("utf8"));
  if (!ogImage) return fail("no_og_image");

  let previewUrl: URL;
  try {
    previewUrl = new URL(ogImage);
  } catch {
    return fail("no_og_image");
  }
  if (previewUrl.protocol !== "https:" || previewUrl.hostname !== SOCIAL_PREVIEW_HOST) {
    return fail("untrusted_host");
  }

  let image: Response;
  try {
    image = await fetchImpl(previewUrl.toString(), {
      method: "GET",
      redirect: "follow",
      headers: { accept: "image/*", "user-agent": USER_AGENT },
      signal: signal(),
    });
  } catch {
    return fail("network");
  }
  if (!image.ok) {
    await image.body?.cancel().catch(() => undefined);
    return fail("http_error");
  }

  const imageBytes = await readLimited(image, MAX_IMAGE_BYTES);
  if (!imageBytes) return fail("too_large");

  const validated = await validateImage(imageBytes);
  if (!validated.ok) return fail("unsupported_image");

  return {
    ok: true,
    preview: {
      bytes: imageBytes,
      mime: validated.mime,
      width: validated.width,
      height: validated.height,
      sourceUrl: previewUrl.toString(),
    },
  };
}
