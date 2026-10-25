import { getDb } from "@/db/client";
import type { GithubConfig } from "@/lib/config";
import { loadGithubConfig } from "@/lib/github/app-config";
import { GithubAppClient } from "@/lib/github/client";
import type { DownloadTarget } from "./resolve";

/** One seam, so route tests can stub the upstream without a GitHub App. */
export type UpstreamFetcher = (target: DownloadTarget) => Promise<Response>;

export class GithubNotConfiguredError extends Error {
  readonly code = "github_not_configured";

  constructor() {
    super("GitHub App is not configured (configure it in the admin console)");
    this.name = "GithubNotConfiguredError";
  }
}

// The client is kept per config object so installation tokens survive between downloads
// instead of being minted once per request.
let cached: { config: GithubConfig; client: GithubAppClient } | null = null;

/**
 * The 302-to-signed-URL dance lives in `GithubAppClient.downloadAsset` (it must not carry the
 * installation token to the object host), so the proxy just uses the shared client. The
 * client is cached per config object so installation tokens survive between downloads.
 */
function githubClient(github: GithubConfig): GithubAppClient {
  if (cached?.config !== github) {
    cached = { config: github, client: new GithubAppClient(github) };
  }
  return cached.client;
}

export const fetchUpstreamZip: UpstreamFetcher = async (target) => {
  // Console-configured; the loader keeps object identity while the row is unchanged, so the
  // client (and its installation-token cache) survives across downloads.
  const github = await loadGithubConfig(getDb());
  if (!github) throw new GithubNotConfiguredError();
  return githubClient(github).downloadAsset(
    target.repoFullName,
    target.upstreamAssetId,
    target.installationId,
  );
};

/** `null` means GitHub chose to stream the asset itself, so there is nothing to redirect to. */
export type UpstreamRedirector = (target: DownloadTarget) => Promise<string | null>;

/**
 * The redirect download mode's seam: ask GitHub where the bytes are, without carrying them.
 * Shares the client (and its installation-token cache) with the proxy path.
 */
export const fetchUpstreamRedirect: UpstreamRedirector = async (target) => {
  const github = await loadGithubConfig(getDb());
  if (!github) throw new GithubNotConfiguredError();
  return githubClient(github).assetRedirectUrl(
    target.repoFullName,
    target.upstreamAssetId,
    target.installationId,
  );
};
