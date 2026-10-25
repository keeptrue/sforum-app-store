import { and, eq, inArray, ne, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { githubInstallations, githubRepos } from "@/db/schema";
import type { GithubRepository } from "./client";

/**
 * Repository inventory: what GitHub shows the App, and which of those rows a developer is
 * allowed to bind a product to.
 *
 * Two rules decide every query here:
 *
 * 1. A repository is only reachable through an `active` installation that belongs to the
 *    asking account. A suspended or deleted installation keeps its rows (history, review
 *    snapshots) but offers nothing to bind.
 * 2. Binding never trusts a `repo_id` sent by the browser: the row has to exist locally and
 *    still be connected upstream.
 */

export type RepoUpstreamState = "connected" | "degraded" | "disconnected";

export type InstallationSummary = {
  installationId: number;
  accountLogin: string;
  status: "active" | "suspended";
  repoCount: number;
};

export type SelectableRepo = {
  repoId: number;
  installationId: number;
  fullName: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string | null;
  upstreamState: RepoUpstreamState;
};

export type BindableRepo = {
  repoId: number;
  installationId: number;
  fullName: string;
  archived: boolean;
};

/** GitHub caps this endpoint at 100 per page; the loop below stops on the first short page. */
const REPOS_PER_PAGE = 100;
/**
 * Ten pages is 1000 repositories. A larger installation is not something this store can
 * present honestly in a picker, so it is reported as an error instead of a truncated list.
 */
const MAX_REPO_PAGES = 10;

export class GithubRepoError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message?: string) {
    super(message ?? code);
    this.name = "GithubRepoError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Upsert one repository row. Moved out of the webhook job so the picker, the webhook and the
 * manual refresh all write the same shape.
 */
export async function upsertRepo(
  db: Db,
  input: {
    repoId: number;
    installationId: number;
    fullName: string;
    private?: boolean;
    archived?: boolean;
    defaultBranch?: string | null;
    upstreamState?: RepoUpstreamState;
  },
): Promise<void> {
  await db
    .insert(githubRepos)
    .values({
      repoId: input.repoId,
      installationId: input.installationId,
      fullName: input.fullName,
      private: input.private ?? false,
      archived: input.archived ?? false,
      defaultBranch: input.defaultBranch ?? null,
      upstreamState: input.upstreamState ?? "connected",
      checkedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: githubRepos.repoId,
      set: {
        installationId: input.installationId,
        fullName: input.fullName,
        private: input.private ?? false,
        archived: input.archived ?? false,
        defaultBranch: input.defaultBranch ?? null,
        ...(input.upstreamState ? { upstreamState: input.upstreamState } : {}),
        checkedAt: new Date(),
        updatedAt: new Date(),
      },
    });
}

function toSelectable(row: typeof githubRepos.$inferSelect): SelectableRepo {
  return {
    repoId: row.repoId,
    installationId: row.installationId,
    fullName: row.fullName,
    private: row.private,
    archived: row.archived,
    defaultBranch: row.defaultBranch,
    upstreamState: row.upstreamState,
  };
}

/** Installations the account ran, minus the ones GitHub reports as deleted. */
export async function listAccountInstallations(
  db: Db,
  accountId: string,
): Promise<InstallationSummary[]> {
  const rows = await db
    .select({
      installationId: githubInstallations.installationId,
      accountLogin: githubInstallations.accountLogin,
      status: githubInstallations.status,
    })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.accountId, accountId),
        ne(githubInstallations.status, "deleted"),
      ),
    )
    .orderBy(githubInstallations.accountLogin, githubInstallations.installationId);

  if (rows.length === 0) return [];

  const counts = await db
    .select({
      installationId: githubRepos.installationId,
      count: sql<number>`count(*)::int`,
    })
    .from(githubRepos)
    .where(
      inArray(
        githubRepos.installationId,
        rows.map((row) => row.installationId),
      ),
    )
    .groupBy(githubRepos.installationId);

  const byInstallation = new Map(counts.map((row) => [row.installationId, row.count]));
  return rows.map((row) => ({
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    status: row.status === "suspended" ? "suspended" : "active",
    repoCount: byInstallation.get(row.installationId) ?? 0,
  }));
}

/**
 * Every repository the account can bind: reachable through one of its `active`
 * installations and not disconnected upstream. Archived repositories stay in the list —
 * the picker disables them with a reason instead of hiding a repository the developer knows
 * they own.
 */
export async function listSelectableRepos(
  db: Db,
  accountId: string,
): Promise<SelectableRepo[]> {
  const installations = await db
    .select({ installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.accountId, accountId),
        eq(githubInstallations.status, "active"),
      ),
    );

  if (installations.length === 0) return [];

  const rows = await db
    .select()
    .from(githubRepos)
    .where(
      and(
        inArray(
          githubRepos.installationId,
          installations.map((row) => row.installationId),
        ),
        ne(githubRepos.upstreamState, "disconnected"),
      ),
    )
    .orderBy(githubRepos.fullName);

  return rows.map(toSelectable);
}

/**
 * Resolve a repository id the browser sent into a row the account may actually bind.
 *
 * Returns `null` for every rejection — unknown id, someone else's installation, suspended
 * installation, disconnected upstream — so the caller can answer 404 without leaking which
 * of those happened.
 */
export async function findBindableRepo(
  db: Db,
  accountId: string,
  repoId: number,
): Promise<BindableRepo | null> {
  const [row] = await db
    .select({
      repoId: githubRepos.repoId,
      installationId: githubRepos.installationId,
      fullName: githubRepos.fullName,
      archived: githubRepos.archived,
      upstreamState: githubRepos.upstreamState,
      installationStatus: githubInstallations.status,
      installationAccountId: githubInstallations.accountId,
    })
    .from(githubRepos)
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.installationId, githubRepos.installationId),
    )
    .where(eq(githubRepos.repoId, repoId))
    .limit(1);

  if (!row) return null;
  if (row.installationAccountId !== accountId) return null;
  if (row.installationStatus !== "active") return null;
  if (row.upstreamState === "disconnected") return null;

  return {
    repoId: row.repoId,
    installationId: row.installationId,
    fullName: row.fullName,
    archived: row.archived,
  };
}

/**
 * Pull the installation's repository list from GitHub and mirror it locally.
 *
 * Returns how many rows were written. Throws `GithubRepoError` when the installation covers
 * more repositories than the picker is willing to page through, rather than silently
 * showing a prefix.
 */
export async function syncInstallationRepos(
  db: Db,
  client: RepoListerClient,
  installationId: number,
): Promise<number> {
  let total = 0;
  let written = 0;

  for (let page = 1; page <= MAX_REPO_PAGES; page += 1) {
    const result = await client.listInstallationRepositories(installationId, page);
    total = result.totalCount;
    for (const repo of result.repositories) {
      await upsertRepo(db, {
        repoId: repo.id,
        installationId,
        fullName: repo.full_name,
        private: repo.private,
        archived: repo.archived,
        defaultBranch: repo.default_branch,
        upstreamState: "connected",
      });
      written += 1;
    }
    if (result.repositories.length < REPOS_PER_PAGE) break;
    if (written >= total) break;
  }

  if (total > written) {
    throw new GithubRepoError(
      "installation_repo_limit",
      409,
      `installation covers ${total} repositories; only ${written} were mirrored`,
    );
  }
  return written;
}

/** The subset of `GithubAppClient` this module needs; a fake satisfies it in tests. */
export type RepoListerClient = {
  listInstallationRepositories(
    installationId: number,
    page?: number,
  ): Promise<{ totalCount: number; repositories: GithubRepository[] }>;
};
