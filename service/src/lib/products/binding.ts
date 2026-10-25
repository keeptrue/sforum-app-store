import { eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import { githubInstallations, githubRepos } from "@/db/schema";
import type { GithubConfig } from "@/lib/config";
import { readExtensionZip } from "@/lib/detection/zip";
import {
  GithubAppConfigError,
  loadGithubConfig,
} from "@/lib/github/app-config";
import { downloadReleaseAsset } from "@/lib/github/assets";
import { closeClaimsForRepoExtension } from "@/lib/github/claims";
import { GithubAppClient, GithubError } from "@/lib/github/client";
import {
  findBindableRepo,
  type RepoUpstreamState,
} from "@/lib/github/repos";
import { syncRelease, type SyncIssue } from "@/lib/github/sync";
import { recordAudit } from "@/lib/moderation/events";
import { refreshProductReadme } from "@/lib/github/readme";
import { refreshProductBrand } from "./brand";
import {
  clearProductRepo,
  findProductByExtensionId,
  setProductRepo,
  type ProductRow,
} from "./store";
import {
  createProduct,
  getDashboardProduct,
  ProductError,
  requireOwnedProduct,
} from "./service";
import type { DashboardProductDetail } from "./types";

/**
 * Product ↔ repository binding.
 *
 * Two rules live here, and nowhere else:
 *
 * 1. A binding is always resolved through `findBindableRepo`, which checks that the
 *    repository sits behind an `active` installation owned by the asking account. The
 *    browser sends a repo id; it never decides who owns it.
 * 2. Binding is a separate operation from editing. `parseProductPatch` rejects `repo_id`
 *    on purpose, so the only way to move a binding is one of these functions, each of
 *    which writes an audit row.
 *
 * `installation` is the only binding strength v1 can offer. A verified GitHub identity
 * (`github_identity`) is the next step; the column already distinguishes the two, and the
 * review console shows which one applies instead of claiming "verified".
 */

export type RepoBindingView = {
  repoId: number;
  fullName: string;
  private: boolean;
  archived: boolean;
  upstreamState: RepoUpstreamState;
  installationLogin: string;
};

/** Read the repository row a product points at, for the binding panel. */
export async function loadRepoBinding(
  db: Db,
  repoId: number,
): Promise<RepoBindingView | null> {
  const [row] = await db
    .select({
      repoId: githubRepos.repoId,
      fullName: githubRepos.fullName,
      private: githubRepos.private,
      archived: githubRepos.archived,
      upstreamState: githubRepos.upstreamState,
      installationLogin: githubInstallations.accountLogin,
    })
    .from(githubRepos)
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.installationId, githubRepos.installationId),
    )
    .where(eq(githubRepos.repoId, repoId))
    .limit(1);

  return row ?? null;
}

async function githubConfig(db: Db): Promise<GithubConfig> {
  try {
    const config = await loadGithubConfig(db);
    if (config) return config;
  } catch (error) {
    // Stored but unreadable / keyless: the developer cannot fix it, but "GitHub is down" with
    // the real reason beats a bare 500 on a dashboard button.
    if (error instanceof GithubAppConfigError) {
      throw new ProductError(error.code, 503, error.message);
    }
    throw error;
  }
  throw new ProductError("github_not_configured", 503);
}

async function requireBindableRepo(
  db: Db,
  accountId: string,
  repoId: number,
) {
  const repo = await findBindableRepo(db, accountId, repoId);
  // Unknown id, someone else's installation, suspended installation, disconnected
  // upstream: all of them are "no such repository" to the caller.
  if (!repo) throw new ProductError("repo_not_bindable", 404);
  if (repo.archived) throw new ProductError("repo_archived", 409);
  return repo;
}

export async function bindProductRepo(
  db: Db,
  input: {
    accountId: string;
    productId: string;
    repoId: number;
    ip?: string | null;
  },
): Promise<DashboardProductDetail> {
  const { product } = await requireOwnedProduct(db, input.productId, input.accountId);
  const repo = await requireBindableRepo(db, input.accountId, input.repoId);

  if (product.repoId === repo.repoId) {
    // Idempotent: re-binding the same repository must not look like a change to review.
    return getDashboardProduct(db, {
      accountId: input.accountId,
      productId: product.id,
    });
  }

  await setProductRepo(db, product.id, input.accountId, {
    repoId: repo.repoId,
    boundVia: "installation",
  });
  // Binding answers any proposal this repository made for this extension id: the queue
  // must not keep asking for something that now has an owner.
  await closeClaimsForRepoExtension(db, {
    repoId: repo.repoId,
    extensionId: product.extensionId,
    productId: product.id,
    accountId: input.accountId,
  });
  await recordAudit(db, {
    actorAccountId: input.accountId,
    action: "product.repo_bound",
    targetType: "product",
    targetId: product.id,
    details: {
      repoId: repo.repoId,
      repoFullName: repo.fullName,
      previousRepoId: product.repoId,
      via: "installation",
    },
    ip: input.ip ?? null,
  });

  return getDashboardProduct(db, {
    accountId: input.accountId,
    productId: product.id,
  });
}

/**
 * Drop the binding.
 *
 * A published product cannot be unbound: its download links and its review snapshot are
 * built from the repository it ships. Moving to another repository is still allowed and
 * goes through review again (`repo_changed` in `lib/moderation/policy.ts`).
 */
export async function unbindProductRepo(
  db: Db,
  input: { accountId: string; productId: string; ip?: string | null },
): Promise<DashboardProductDetail> {
  const { product } = await requireOwnedProduct(db, input.productId, input.accountId);

  if (product.status === "published") {
    throw new ProductError("repo_binding_locked", 409);
  }
  if (product.repoId === null) {
    return getDashboardProduct(db, {
      accountId: input.accountId,
      productId: product.id,
    });
  }

  await clearProductRepo(db, product.id, input.accountId);
  await recordAudit(db, {
    actorAccountId: input.accountId,
    action: "product.repo_unbound",
    targetType: "product",
    targetId: product.id,
    details: { previousRepoId: product.repoId },
    ip: input.ip ?? null,
  });

  return getDashboardProduct(db, {
    accountId: input.accountId,
    productId: product.id,
  });
}

/**
 * The GitHub surface an import needs. A fake satisfies it in tests; production passes the
 * real client.
 */
export type ImportClient = Pick<
  GithubAppClient,
  "getLatestRelease" | "downloadAsset"
>;

export type ImportResult = {
  product: DashboardProductDetail;
  created: boolean;
  issues: SyncIssue[];
};

/**
 * Create (or adopt) a product from a repository's latest release.
 *
 * This is the "从仓库导入" path: the manifest inside the release decides `extension_id`,
 * name and kind, so the developer never types an id that GitHub has to match later. The
 * ZIP only ever touches a temp directory (`downloadReleaseAsset` cleans up), and the same
 * release is synced immediately so the product does not start empty.
 */
export async function importProductFromRepo(
  db: Db,
  input: {
    accountId: string;
    repoId: number;
    ip?: string | null;
    client?: ImportClient;
  },
): Promise<ImportResult> {
  const repo = await requireBindableRepo(db, input.accountId, input.repoId);
  const client = input.client ?? new GithubAppClient(await githubConfig(db));

  let release;
  try {
    release = await client.getLatestRelease(repo.fullName, repo.installationId);
  } catch (error) {
    if (error instanceof GithubError && error.status === 404) {
      throw new ProductError("repo_has_no_release", 409);
    }
    throw error;
  }

  const zipAsset = release.assets.find((asset) =>
    asset.name.toLowerCase().endsWith(".zip"),
  );
  if (!zipAsset) throw new ProductError("repo_release_has_no_zip", 409);

  const downloaded = await downloadReleaseAsset(
    client,
    repo.fullName,
    repo.installationId,
    zipAsset,
  );
  let manifest;
  try {
    manifest = (await readExtensionZip(downloaded.path)).manifest;
  } finally {
    await downloaded.cleanup();
  }

  const existing: ProductRow | null = await findProductByExtensionId(db, manifest.id);
  if (existing && existing.ownerAccountId !== input.accountId) {
    throw new ProductError("extension_id_taken", 409);
  }
  if (existing && existing.repoId !== null && existing.repoId !== repo.repoId) {
    throw new ProductError("extension_id_bound_elsewhere", 409);
  }

  let productId: string;
  let created = false;
  if (existing) {
    productId = existing.id;
    if (existing.repoId === null) {
      await setProductRepo(db, existing.id, input.accountId, {
        repoId: repo.repoId,
        boundVia: "installation",
      });
    }
  } else {
    const createdRow = await createProduct(db, {
      accountId: input.accountId,
      extensionId: manifest.id,
      name: manifest.name,
      kind: manifest.type,
      summary: "",
    });
    productId = createdRow.id;
    created = true;
    await setProductRepo(db, productId, input.accountId, {
      repoId: repo.repoId,
      boundVia: "installation",
    });
  }

  // Sync the release that produced the manifest. The webhook for it fired before the
  // product existed, so without this the product would stay empty until the next release.
  const sync = await syncRelease({
    db,
    repoId: repo.repoId,
    installationId: repo.installationId,
    release,
    fetchAsset: (asset) =>
      downloadReleaseAsset(client, repo.fullName, repo.installationId, asset),
  });

  await closeClaimsForRepoExtension(db, {
    repoId: repo.repoId,
    extensionId: manifest.id,
    productId,
    accountId: input.accountId,
  });

  // Best effort, and deliberately after the product exists: a repository with an unreadable
  // README or no brand assets still imports. The dashboard shows "还没有读取到 README" and
  // each panel's refresh button is the retry.
  await Promise.allSettled([
    refreshProductReadme(db, {
      productId,
      actorAccountId: input.accountId,
    }),
    refreshProductBrand(db, { productId }),
  ]);

  await recordAudit(db, {
    actorAccountId: input.accountId,
    action: created ? "product.repo_imported" : "product.repo_adopted",
    targetType: "product",
    targetId: productId,
    details: {
      repoId: repo.repoId,
      repoFullName: repo.fullName,
      extensionId: manifest.id,
      tag: release.tag_name,
      versions: sync.versions,
      issues: sync.issues,
    },
    ip: input.ip ?? null,
  });

  return {
    product: await getDashboardProduct(db, {
      accountId: input.accountId,
      productId,
    }),
    created,
    issues: sync.issues,
  };
}
