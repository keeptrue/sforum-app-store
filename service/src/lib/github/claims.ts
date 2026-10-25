import { and, desc, eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import { githubInstallations, githubRepos, repoClaims } from "@/db/schema";

/**
 * Repository claims: a release arrived for an `extension_id` that no product owns yet.
 *
 * Sync used to create the product on the spot and hand ownership to whichever installation
 * ran the sync, so the first release to arrive won the id. Now it only records a proposal.
 * Turning a proposal into a product is a developer action
 * (`lib/products/binding.ts` → `claimRepoCandidate`), and the claim queue is scoped to the
 * account that owns the installation the release came from.
 */

export type RepoClaimState = "pending" | "claimed" | "rejected";

export type RecordClaimInput = {
  repoId: number;
  installationId: number;
  extensionId: string;
  manifestName: string | null;
  tag: string | null;
  githubReleaseId: number | null;
};

export type PendingClaim = {
  id: string;
  repoId: number;
  repoFullName: string;
  installationId: number;
  accountLogin: string;
  extensionId: string;
  manifestName: string | null;
  tag: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Record (or refresh) the proposal for one (repository, extension) pair.
 *
 * A row that a developer already claimed is left alone: a later release must not reopen a
 * decision that produced a product. `setWhere` keeps that guarantee inside the statement, so
 * two concurrent releases cannot race the queue back to `pending`.
 */
export async function recordClaim(
  db: Db,
  input: RecordClaimInput,
): Promise<void> {
  await db
    .insert(repoClaims)
    .values({
      repoId: input.repoId,
      installationId: input.installationId,
      extensionId: input.extensionId,
      manifestName: input.manifestName,
      tag: input.tag,
      githubReleaseId: input.githubReleaseId,
      state: "pending",
    })
    .onConflictDoUpdate({
      target: [repoClaims.repoId, repoClaims.extensionId],
      set: {
        installationId: input.installationId,
        manifestName: input.manifestName,
        tag: input.tag,
        githubReleaseId: input.githubReleaseId,
        updatedAt: new Date(),
      },
      setWhere: eq(repoClaims.state, "pending"),
    });
}

const claimColumns = {
  id: repoClaims.id,
  repoId: repoClaims.repoId,
  repoFullName: githubRepos.fullName,
  installationId: repoClaims.installationId,
  accountLogin: githubInstallations.accountLogin,
  extensionId: repoClaims.extensionId,
  manifestName: repoClaims.manifestName,
  tag: repoClaims.tag,
  createdAt: repoClaims.createdAt,
  updatedAt: repoClaims.updatedAt,
};

function toPending(row: {
  id: string;
  repoId: number;
  repoFullName: string;
  installationId: number;
  accountLogin: string;
  extensionId: string;
  manifestName: string | null;
  tag: string | null;
  createdAt: Date;
  updatedAt: Date;
}): PendingClaim {
  return {
    id: row.id,
    repoId: row.repoId,
    repoFullName: row.repoFullName,
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    extensionId: row.extensionId,
    manifestName: row.manifestName,
    tag: row.tag,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Pending proposals whose repository sits behind one of the account's active installs. */
export async function listPendingClaims(
  db: Db,
  accountId: string,
): Promise<PendingClaim[]> {
  const rows = await db
    .select(claimColumns)
    .from(repoClaims)
    .innerJoin(githubRepos, eq(githubRepos.repoId, repoClaims.repoId))
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.installationId, repoClaims.installationId),
    )
    .where(
      and(
        eq(repoClaims.state, "pending"),
        eq(githubInstallations.accountId, accountId),
        eq(githubInstallations.status, "active"),
      ),
    )
    .orderBy(desc(repoClaims.updatedAt));

  return rows.map(toPending);
}

/** One pending proposal, or `null` when it is missing, foreign or already decided. */
export async function findPendingClaim(
  db: Db,
  accountId: string,
  claimId: string,
): Promise<PendingClaim | null> {
  const [row] = await db
    .select(claimColumns)
    .from(repoClaims)
    .innerJoin(githubRepos, eq(githubRepos.repoId, repoClaims.repoId))
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.installationId, repoClaims.installationId),
    )
    .where(
      and(
        eq(repoClaims.id, claimId),
        eq(repoClaims.state, "pending"),
        eq(githubInstallations.accountId, accountId),
        eq(githubInstallations.status, "active"),
      ),
    )
    .limit(1);

  return row ? toPending(row) : null;
}

/**
 * Close a claim against the product it produced. Returns false when another request already
 * closed it — the caller turns that into a conflict instead of creating a second product.
 */
export async function markClaimed(
  db: Db,
  input: { claimId: string; productId: string; accountId: string },
): Promise<boolean> {
  const rows = await db
    .update(repoClaims)
    .set({
      state: "claimed",
      claimedProductId: input.productId,
      claimedByAccountId: input.accountId,
      claimedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(repoClaims.id, input.claimId), eq(repoClaims.state, "pending")))
    .returning({ id: repoClaims.id });

  return rows.length > 0;
}

/**
 * Close every pending proposal for one (repository, extension) pair.
 *
 * An import creates the product from the release itself, so any proposal pointing at the
 * same pair is answered — including ones recorded by an earlier tag. Proposals for *other*
 * extension ids in the same repository stay pending on purpose: those still need an owner.
 */
export async function closeClaimsForRepoExtension(
  db: Db,
  input: {
    repoId: number;
    extensionId: string;
    productId: string;
    accountId: string;
  },
): Promise<number> {
  const rows = await db
    .update(repoClaims)
    .set({
      state: "claimed",
      claimedProductId: input.productId,
      claimedByAccountId: input.accountId,
      claimedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(repoClaims.repoId, input.repoId),
        eq(repoClaims.extensionId, input.extensionId),
        eq(repoClaims.state, "pending"),
      ),
    )
    .returning({ id: repoClaims.id });

  return rows.length;
}
