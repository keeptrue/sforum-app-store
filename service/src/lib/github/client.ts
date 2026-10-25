import type { GithubConfig } from "@/lib/config";
import { createAppJwt } from "./jwt";

export type GithubReleaseAsset = {
  id: number;
  name: string;
  size: number;
  content_type: string;
  browser_download_url: string;
};

export type GithubRelease = {
  id: number;
  tag_name: string;
  target_commitish: string;
  prerelease: boolean;
  draft: boolean;
  body: string | null;
  assets: GithubReleaseAsset[];
};

export type GithubInstallation = {
  id: number;
  account: { login: string; type?: string };
  suspended_at: string | null;
};

/** The subset of `GET /app` the console verification reads. */
export type GithubAppIdentity = {
  id: number;
  slug: string;
  name: string;
  owner?: { login?: string } | null;
};

export type GithubRepository = {
  id: number;
  full_name: string;
  private: boolean;
  archived: boolean;
  default_branch: string | null;
};

/**
 * The subset of `GET /repos/{owner}/{repo}/readme` the store keeps. `sha` is GitHub's blob
 * digest and is the only cheap way to tell "the README changed" from "we fetched it again".
 */
export type GithubReadme = {
  path: string;
  sha: string;
  /** Decoded UTF-8 source. GitHub caps the inline `content` field at 1 MiB. */
  content: string;
};

/** GitHub refuses to inline a file larger than this, so a bigger README is an error. */
export const GITHUB_README_MAX_BYTES = 1024 * 1024;

/**
 * One repository blob read through the installation token. `sha` is the git object id, the
 * cheapest signal that a file did not move; `bytes` is the decoded body.
 */
export type GithubRepoFile = {
  sha: string;
  bytes: Buffer;
};

/** One entry of a git tree listing; only `path` and `type` are read. */
export type GithubTreeEntry = { path: string; type: string };

/** A recursive listing of the default branch. `truncated` means GitHub answered partially. */
export type GithubTree = { entries: GithubTreeEntry[]; truncated: boolean };

/**
 * A recursive tree can be a few hundred kilobytes for a normal repository and several
 * megabytes for a monorepo. Above this the listing is refused: the caller falls back to the
 * repository root instead of holding an unbounded document in memory.
 */
export const GITHUB_TREE_MAX_BYTES = 4 * 1024 * 1024;

/** The run fields the review console reads; everything else in the payload is ignored. */
export type GithubWorkflowRun = {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  run_started_at: string | null;
  created_at: string;
};

export class GithubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GithubError";
    this.status = status;
  }
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type CachedToken = { token: string; expiresAt: number };

const API_VERSION = "2022-11-28";

export class GithubAppClient {
  private readonly cache = new Map<number, CachedToken>();
  private readonly config: GithubConfig;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(
    config: GithubConfig,
    options: { fetchImpl?: FetchLike; now?: () => number } = {},
  ) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private key(): { kid: string; pem: string } {
    const kids = Array.from(this.config.privateKeys.keys());
    const kid = kids[kids.length - 1];
    const pem = this.config.privateKeys.get(kid);
    if (!pem) throw new GithubError(500, "no GitHub App private key");
    return { kid, pem };
  }

  private jwt(): string {
    const { kid, pem } = this.key();
    return createAppJwt({
      appId: this.config.appId,
      privateKeyPem: pem,
      kid,
      now: this.now(),
    });
  }

  /**
   * Raw request: no status interpretation.
   *
   * `redirect: "manual"` is deliberate — the release-asset endpoint answers `302` to a
   * short-lived signed URL, and following it automatically would carry the installation
   * token to a host that rejects it (S3 fix; see `downloadAsset`).
   */
  private async send(
    path: string,
    init: RequestInit,
    auth: { type: "app" } | { type: "token"; token: string },
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("accept", headers.get("accept") ?? "application/vnd.github+json");
    headers.set("x-github-api-version", API_VERSION);
    headers.set("user-agent", "sforum-app-store");
    headers.set(
      "authorization",
      auth.type === "app" ? `Bearer ${this.jwt()}` : `Bearer ${auth.token}`,
    );

    return this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
      ...init,
      headers,
      redirect: "manual",
    });
  }

  private async request(
    path: string,
    init: RequestInit,
    auth: { type: "app" } | { type: "token"; token: string },
  ): Promise<Response> {
    const response = await this.send(path, init, auth);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new GithubError(
        response.status,
        body.message ?? `GitHub API ${response.status}`,
      );
    }
    return response;
  }

  /**
   * `GET /app`: who the stored app id + private key actually are. Used by the console's
   * "验证" button, which is the only way to catch a slug that does not belong to this key
   * before an install link 404s.
   */
  async getApp(): Promise<GithubAppIdentity> {
    const response = await this.request(`/app`, { method: "GET" }, { type: "app" });
    return (await response.json()) as GithubAppIdentity;
  }

  async getInstallation(installationId: number): Promise<GithubInstallation> {
    const response = await this.request(
      `/app/installations/${installationId}`,
      { method: "GET" },
      { type: "app" },
    );
    return (await response.json()) as GithubInstallation;
  }

  async getInstallationToken(installationId: number): Promise<string> {
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAt - this.now() > 60_000) {
      return cached.token;
    }

    const response = await this.request(
      `/app/installations/${installationId}/access_tokens`,
      { method: "POST" },
      { type: "app" },
    );
    const body = (await response.json()) as {
      token?: string;
      expires_at?: string;
    };
    if (!body.token || !body.expires_at) {
      throw new GithubError(502, "GitHub installation token response is invalid");
    }
    const expiresAt = Date.parse(body.expires_at);
    if (!Number.isFinite(expiresAt)) {
      throw new GithubError(502, "GitHub installation token expiry is invalid");
    }
    this.cache.set(installationId, { token: body.token, expiresAt });
    return body.token;
  }

  /**
   * One page of the installation's repositories.
   *
   * `total_count` is returned with the page so the caller can tell "this is all of them"
   * from "there is another page" without guessing from a short page.
   */
  async listInstallationRepositories(
    installationId: number,
    page = 1,
  ): Promise<{ totalCount: number; repositories: GithubRepository[] }> {
    const token = await this.getInstallationToken(installationId);
    const response = await this.request(
      `/installation/repositories?per_page=100&page=${page}`,
      { method: "GET" },
      { type: "token", token },
    );
    const body = (await response.json()) as {
      total_count?: number;
      repositories?: GithubRepository[];
    };
    const repositories = body.repositories ?? [];
    const totalCount =
      typeof body.total_count === "number" && body.total_count >= 0
        ? body.total_count
        : repositories.length;
    return { totalCount, repositories };
  }

  async getRelease(
    repoFullName: string,
    releaseId: number,
    installationId: number,
  ): Promise<GithubRelease> {
    const token = await this.getInstallationToken(installationId);
    const response = await this.request(
      `/repos/${repoFullName}/releases/${releaseId}`,
      { method: "GET" },
      { type: "token", token },
    );
    return (await response.json()) as GithubRelease;
  }

  /**
   * The repository's latest published release.
   *
   * GitHub answers 404 when the repository has no release yet; the caller turns that into
   * "create a release first" instead of treating it as an upstream failure.
   */
  async getLatestRelease(
    repoFullName: string,
    installationId: number,
  ): Promise<GithubRelease> {
    const token = await this.getInstallationToken(installationId);
    const response = await this.request(
      `/repos/${repoFullName}/releases/latest`,
      { method: "GET" },
      { type: "token", token },
    );
    return (await response.json()) as GithubRelease;
  }

  /**
   * Resolve a ref (tag, branch or commit SHA) to the commit it points at.
   *
   * A release's `target_commitish` is whatever the author typed when creating it — usually
   * a branch name — so the tag is the only reliable pointer to the commit a release ships.
   * `commits/{ref}` also dereferences an annotated tag to its commit, which `git/ref` would
   * not do in one step.
   *
   * Used exclusively for the review-console hint (plan §7.4 item 25): `Actions: read` never
   * gates anything.
   */
  async getCommitSha(
    repoFullName: string,
    ref: string,
    installationId: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const token = await this.getInstallationToken(installationId);
    const response = await this.request(
      `/repos/${repoFullName}/commits/${encodeURIComponent(ref)}`,
      { method: "GET", signal },
      { type: "token", token },
    );
    const body = (await response.json()) as { sha?: unknown };
    if (typeof body.sha !== "string" || body.sha.length === 0) {
      throw new GithubError(502, "GitHub commit response is invalid");
    }
    return body.sha;
  }

  /**
   * Workflow runs recorded for one commit. Filtering by `head_sha` is the only query that
   * answers "what did CI say about this exact commit"; `branch` does not accept tags.
   */
  async listWorkflowRunsForCommit(
    repoFullName: string,
    commitSha: string,
    installationId: number,
    signal?: AbortSignal,
  ): Promise<GithubWorkflowRun[]> {
    const token = await this.getInstallationToken(installationId);
    const response = await this.request(
      `/repos/${repoFullName}/actions/runs?head_sha=${encodeURIComponent(commitSha)}&per_page=20`,
      { method: "GET", signal },
      { type: "token", token },
    );
    const body = (await response.json()) as { workflow_runs?: unknown };
    if (!Array.isArray(body.workflow_runs)) {
      throw new GithubError(502, "GitHub workflow runs response is invalid");
    }
    return body.workflow_runs as GithubWorkflowRun[];
  }

  /**
   * The repository's README as GitHub resolves it (README.md, README.rst, readme.txt, …).
   *
   * The JSON form is used instead of `application/vnd.github.raw` because the store needs
   * `path` and `sha` as well as the bytes, and one request is better than two. A README over
   * GitHub's 1 MiB inline limit comes back with an empty `content`; that is reported as a
   * size error rather than rendered as an empty page.
   */
  async getReadme(
    repoFullName: string,
    installationId: number,
  ): Promise<GithubReadme> {
    const token = await this.getInstallationToken(installationId);
    const response = await this.request(
      `/repos/${repoFullName}/readme`,
      { method: "GET" },
      { type: "token", token },
    );
    const body = (await response.json()) as {
      path?: unknown;
      sha?: unknown;
      content?: unknown;
      encoding?: unknown;
      size?: unknown;
    };
    if (typeof body.path !== "string" || body.path.length === 0) {
      throw new GithubError(502, "GitHub readme response is missing path");
    }
    if (typeof body.sha !== "string" || body.sha.length === 0) {
      throw new GithubError(502, "GitHub readme response is missing sha");
    }
    if (typeof body.size === "number" && body.size > GITHUB_README_MAX_BYTES) {
      throw new GithubError(413, "readme_too_large");
    }
    if (typeof body.content !== "string" || body.content.length === 0) {
      throw new GithubError(413, "readme_too_large");
    }
    if (body.encoding !== undefined && body.encoding !== "base64") {
      throw new GithubError(502, "GitHub readme encoding is not base64");
    }

    return {
      path: body.path,
      sha: body.sha,
      content: Buffer.from(body.content, "base64").toString("utf8"),
    };
  }

  /**
   * Read one file from a repository at a ref, through the installation token.
   *
   * Contents API only: it answers with the blob `sha` as well as the bytes, so a refresh can
   * compare first and skip the download when the file did not move. `maxBytes` is enforced
   * from the reported `size` and again after decoding; a caller that only wants a bounded
   * image never has to hold a larger buffer.
   *
   * A missing file throws `GithubError(404)` — the caller decides whether that is a normal
   * state (a repository that never adopted `brand/`) or a failure.
   */
  async getRepoFile(
    repoFullName: string,
    installationId: number,
    path: string,
    options: { ref?: string | null; maxBytes: number },
  ): Promise<GithubRepoFile> {
    // Segment-wise encoding: the path comes from our own constants, but a caller-supplied
    // `ref` or a renamed default branch must not be able to append a query.
    const encoded = path
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const ref = options.ref?.trim();
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";

    const token = await this.getInstallationToken(installationId);
    const response = await this.request(
      `/repos/${repoFullName}/contents/${encoded}${query}`,
      { method: "GET" },
      { type: "token", token },
    );
    const body = (await response.json()) as {
      sha?: unknown;
      size?: unknown;
      content?: unknown;
      encoding?: unknown;
      type?: unknown;
    };
    if (typeof body.sha !== "string" || body.sha.length === 0) {
      throw new GithubError(502, "GitHub contents response is missing sha");
    }
    // A directory, a symlink or a submodule answers without inline content; brand assets are
    // plain files, so anything else is reported as unsupported rather than decoded.
    if (body.type !== undefined && body.type !== "file") {
      throw new GithubError(415, "github_contents_not_a_file");
    }
    if (typeof body.size === "number" && body.size > options.maxBytes) {
      throw new GithubError(413, "github_contents_too_large");
    }
    if (typeof body.content !== "string" || body.content.length === 0) {
      throw new GithubError(413, "github_contents_too_large");
    }
    if (body.encoding !== undefined && body.encoding !== "base64") {
      throw new GithubError(502, "github contents encoding is not base64");
    }

    const bytes = Buffer.from(body.content, "base64");
    if (bytes.byteLength > options.maxBytes) {
      throw new GithubError(413, "github_contents_too_large");
    }
    return { sha: body.sha, bytes };
  }

  /**
   * Recursive listing of one ref, used to find where the extension package lives.
   *
   * The brand contract puts `brand/` **inside the package**, and a package directory may be
   * nested (`plugins/sforum-oauth2-provider/`). The release ZIP cannot tell us that path —
   * the manifest is at the ZIP root by contract — so the only way to find `brand/` is to look
   * at the tree. One call per refresh, and GitHub answers with blobs only: no file is read.
   *
   * A tree that GitHub truncated (huge repository) is reported as such rather than guessed
   * at; the caller then behaves as if the package were at the root.
   */
  async listRepoTree(
    repoFullName: string,
    installationId: number,
    options: { ref?: string | null; maxBytes?: number } = {},
  ): Promise<GithubTree> {
    const ref = options.ref?.trim() || "HEAD";
    const limit = options.maxBytes ?? GITHUB_TREE_MAX_BYTES;

    const token = await this.getInstallationToken(installationId);
    const response = await this.request(
      `/repos/${repoFullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      { method: "GET" },
      { type: "token", token },
    );
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > limit) {
      throw new GithubError(413, "github_tree_too_large");
    }

    let body: { tree?: unknown; truncated?: unknown };
    try {
      body = JSON.parse(text) as { tree?: unknown; truncated?: unknown };
    } catch {
      throw new GithubError(502, "github tree response is not JSON");
    }
    if (!Array.isArray(body.tree)) {
      throw new GithubError(502, "github tree response is missing tree");
    }

    const entries: GithubTreeEntry[] = [];
    for (const entry of body.tree) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as { path?: unknown; type?: unknown };
      if (typeof record.path !== "string" || typeof record.type !== "string") continue;
      entries.push({ path: record.path, type: record.type });
    }
    return { entries, truncated: body.truncated === true };
  }

  /**
   * Download a release asset.
   *
   * GitHub answers `302` with a `location` pointing at a signed object URL on
   * `release-assets.githubusercontent.com`. That URL must be fetched WITHOUT the
   * installation token: it is a different host, and sending `Authorization` there both
   * leaks the token and makes the signed request fail. `redirect: "manual"` in `send()`
   * keeps that decision here instead of in the HTTP stack.
   */
  async downloadAsset(
    repoFullName: string,
    assetId: number,
    installationId: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const token = await this.getInstallationToken(installationId);
    const init: RequestInit = {
      method: "GET",
      headers: { accept: "application/octet-stream" },
      signal: signal ?? AbortSignal.timeout(90_000),
    };
    const response = await this.send(
      `/repos/${repoFullName}/releases/assets/${assetId}`,
      init,
      { type: "token", token },
    );

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      // GitHub sends an absolute URL; resolve defensively so a relative Location still works.
      const target = new URL(location, `${this.config.apiBaseUrl}/`).toString();
      const followed = await this.fetchImpl(target, {
        method: "GET",
        redirect: "follow",
        signal: init.signal,
      });
      if (!followed.ok) {
        throw new GithubError(followed.status, `asset download failed: ${followed.status}`);
      }
      return followed;
    }
    if (!response.ok) {
      throw new GithubError(response.status, `asset download failed: ${response.status}`);
    }
    return response;
  }

  /**
   * The `Location` of a release asset's redirect, without following it and without reading a
   * single byte of the object.
   *
   * This is the redirect download mode's whole dependency on GitHub: the signed object URL is
   * a bearer credential the client can hold for as long as GitHub allows, so the store stops
   * being the carrier. Returns `null` when GitHub answers `200` and streams the asset itself
   * (the API documents both behaviours) — the caller must fall back to `downloadAsset`,
   * because in that shape there is no address to hand out.
   */
  async assetRedirectUrl(
    repoFullName: string,
    assetId: number,
    installationId: number,
  ): Promise<string | null> {
    const token = await this.getInstallationToken(installationId);
    const response = await this.send(
      `/repos/${repoFullName}/releases/assets/${assetId}`,
      {
        method: "GET",
        headers: { accept: "application/octet-stream" },
        signal: AbortSignal.timeout(15_000),
      },
      { type: "token", token },
    );
    // Every branch below discards the body: a 200 here would mean streaming the whole asset
    // into memory for a URL we cannot produce.
    response.body?.cancel();

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      // GitHub sends an absolute URL; resolve defensively so a relative Location still works.
      return new URL(location, `${this.config.apiBaseUrl}/`).toString();
    }
    return null;
  }
}
