import { eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import { githubRepos, products } from "@/db/schema";
import { requireGithubConfig } from "@/lib/github/app-config";
import { recordAudit } from "@/lib/moderation/events";
import {
  getProductReadme,
  recordReadmeError,
  upsertProductReadme,
} from "@/lib/products/store";
import { renderReadme } from "@/lib/readme/render";
import { readmeFormatFor, readmeSourceUrl } from "@/lib/readme/source";
import { GithubAppClient, GithubError, type GithubReadme } from "./client";

/**
 * Fetch, render and cache a product's README.
 *
 * The public page reads the cache, never GitHub: a page view must not depend on an outbound
 * request, and an installation token must never be on a visitor-triggered path. Freshness is
 * therefore a cache policy (`lib/products/readme-cache.ts`), not a render concern.
 *
 * The README is **not** part of the review snapshot. That is a recorded decision: review
 * covers the summary and the manifest, while the introduction follows the repository. The
 * mitigation lives here — a changed blob digest is written to the audit trail so the review
 * console can show that the text moved after approval.
 */

export type ReadmeRefreshFailure =
  | "no_repo"
  | "no_readme"
  | "too_large"
  | "github_error"
  | "github_not_configured";

export type ReadmeRefreshResult =
  | {
      ok: true;
      path: string;
      blobSha: string;
      /** True when the digest differs from the previous row (audit was written). */
      changed: boolean;
      html: string;
      fetchedAt: Date;
      /** `https://github.com/<owner>/<repo>/blob/HEAD/<path>` — never an API address. */
      sourceUrl: string;
    }
  | { ok: false; reason: ReadmeRefreshFailure };

export { readmeFormatFor, readmeSourceUrl };

/**
 * The repository facts every repository-backed refresh needs (README, brand files), or null
 * when the product has no binding. `defaultBranch` is what the brand reader uses as its ref:
 * brand assets describe the product, not a release, so they are read from the branch head.
 */
export async function loadRepoTarget(
  db: Db,
  productId: string,
): Promise<{
  repoId: number;
  fullName: string;
  installationId: number;
  defaultBranch: string | null;
  extensionId: string;
} | null> {
  const [row] = await db
    .select({
      repoId: products.repoId,
      extensionId: products.extensionId,
      fullName: githubRepos.fullName,
      installationId: githubRepos.installationId,
      defaultBranch: githubRepos.defaultBranch,
    })
    .from(products)
    .innerJoin(githubRepos, eq(githubRepos.repoId, products.repoId))
    .where(eq(products.id, productId))
    .limit(1);
  if (!row) return null;
  const repoId = row.repoId;
  if (repoId === null) return null;
  return {
    repoId,
    fullName: row.fullName,
    installationId: row.installationId,
    defaultBranch: row.defaultBranch ?? null,
    extensionId: row.extensionId,
  };
}

export async function refreshProductReadme(
  db: Db,
  input: {
    productId: string;
    /** Injected in tests; production builds one from the stored GitHub App config. */
    client?: Pick<GithubAppClient, "getReadme">;
    actorAccountId?: string | null;
  },
): Promise<ReadmeRefreshResult> {
  const target = await loadRepoTarget(db, input.productId);
  if (!target) return { ok: false, reason: "no_repo" };

  let client: Pick<GithubAppClient, "getReadme">;
  if (input.client) {
    client = input.client;
  } else {
    try {
      client = new GithubAppClient(await requireGithubConfig(db));
    } catch {
      return { ok: false, reason: "github_not_configured" };
    }
  }

  let readme: GithubReadme;
  try {
    readme = await client.getReadme(target.fullName, target.installationId);
  } catch (error) {
    if (error instanceof GithubError) {
      const reason: ReadmeRefreshFailure =
        error.status === 404
          ? "no_readme"
          : error.status === 413
            ? "too_large"
            : "github_error";
      await recordReadmeError(db, input.productId, error.message).catch(() => undefined);
      return { ok: false, reason };
    }
    await recordReadmeError(db, input.productId, "readme fetch failed").catch(
      () => undefined,
    );
    return { ok: false, reason: "github_error" };
  }

  const html = renderReadme({
    source: readme.content,
    repoFullName: target.fullName,
    path: readme.path,
    format: readmeFormatFor(readme.path),
  });
  const fetchedAt = new Date();
  const previous = await getProductReadme(db, input.productId);

  await upsertProductReadme(db, {
    productId: input.productId,
    repoId: target.repoId,
    ref: "HEAD",
    path: readme.path,
    blobSha: readme.sha,
    markdown: readme.content,
    html,
    byteSize: Buffer.byteLength(readme.content, "utf8"),
    fetchedAt,
  });

  // A rebind can land on a repository whose README happens to hash the same; the text did
  // not move but the source did, and the audit trail must say so.
  const changed =
    previous !== null &&
    (previous.blobSha !== readme.sha || previous.repoId !== target.repoId);
  if (changed) {
    await recordAudit(db, {
      actorAccountId: input.actorAccountId ?? null,
      action: "product.readme_changed",
      targetType: "product",
      targetId: input.productId,
      details: {
        repoId: target.repoId,
        path: readme.path,
        from: previous.blobSha,
        to: readme.sha,
      },
    });
  }

  return {
    ok: true,
    path: readme.path,
    blobSha: readme.sha,
    changed,
    html,
    fetchedAt,
    sourceUrl: readmeSourceUrl(target.fullName, readme.path),
  };
}
