import { and, eq } from "drizzle-orm";

import { getDb, type Db } from "@/db/client";
import {
  githubInstallations,
  githubRepos,
  products,
  repoReleases,
} from "@/db/schema";
import { scheduleBrandRefresh } from "@/lib/products/brand-cache";
import { requireGithubConfig } from "./app-config";
import { downloadReleaseAsset } from "./assets";
import { GithubAppClient } from "./client";
import { pushTouchesBrand, type PushPayload } from "./push-filter";
import { upsertRepo } from "./repos";
import { syncRelease } from "./sync";

type WebhookPayload = {
  action?: string;
  installation?: { id?: number; account?: { login?: string } };
  repository?: {
    id?: number;
    full_name?: string;
    private?: boolean;
    archived?: boolean;
    default_branch?: string | null;
  };
  release?: {
    id?: number;
    draft?: boolean;
    tag_name?: string;
  };
  repositories_added?: Array<{
    id?: number;
    full_name?: string;
    private?: boolean;
    archived?: boolean;
    default_branch?: string | null;
  }>;
  repositories_removed?: Array<{ id?: number }>;
};

export type GithubWebhookJob = {
  deliveryId: string;
  event: string;
  payload: WebhookPayload;
};

async function setInstallationState(
  db: Db,
  installationId: number,
  status: "active" | "suspended" | "deleted",
): Promise<void> {
  await db
    .update(githubInstallations)
    .set({
      status,
      suspendedAt: status === "suspended" ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(githubInstallations.installationId, installationId));

  if (status !== "active") {
    await db
      .update(githubRepos)
      .set({
        upstreamState: status === "deleted" ? "disconnected" : "degraded",
        checkedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(githubRepos.installationId, installationId));
  }
}

export async function handleGithubWebhookJob(
  job: GithubWebhookJob,
): Promise<void> {
  const db = getDb();
  const payload = job.payload;
  const installationId = payload.installation?.id;

  // A push only ever means "the repository moved, look at brand/ again". The route already
  // dropped pushes that cannot qualify; this re-check keeps an enqueued-but-stale delivery
  // from doing work if the filter ever moves.
  if (job.event === "push") {
    if (pushTouchesBrand(payload as PushPayload)) {
      await refreshBrandsForRepo(db, (payload as PushPayload).repository?.id);
    }
    return;
  }

  if (job.event === "installation" && installationId) {
    const action = payload.action;
    if (action === "deleted") {
      await setInstallationState(db, installationId, "deleted");
    } else if (action === "suspended") {
      await setInstallationState(db, installationId, "suspended");
    } else if (action === "unsuspended") {
      await setInstallationState(db, installationId, "active");
    } else if (action === "created" || action === "new_permissions_accepted") {
      const login = payload.installation?.account?.login;
      if (login) {
        await db
          .insert(githubInstallations)
          .values({
            installationId,
            accountLogin: login,
            status: "active",
          })
          .onConflictDoUpdate({
            target: githubInstallations.installationId,
            set: { accountLogin: login, status: "active", updatedAt: new Date() },
          });
      }
    }
    return;
  }

  if (job.event === "repository" && installationId && payload.repository?.id) {
    const repo = payload.repository;
    if (payload.action === "deleted") {
      await db
        .update(githubRepos)
        .set({
          upstreamState: "disconnected",
          checkedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(githubRepos.repoId, repo.id!));
      return;
    }
    if (repo.full_name) {
      await upsertRepo(db, {
        repoId: repo.id!,
        installationId,
        fullName: repo.full_name,
        private: repo.private,
        archived: repo.archived,
        defaultBranch: repo.default_branch,
      });
    }
    return;
  }

  if (
    job.event === "installation_repositories" &&
    installationId &&
    payload.repositories_removed
  ) {
    for (const repo of payload.repositories_removed) {
      if (!repo.id) continue;
      await db
        .update(githubRepos)
        .set({
          upstreamState: "disconnected",
          checkedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(githubRepos.repoId, repo.id));
    }
    return;
  }

  if (
    job.event === "installation_repositories" &&
    installationId &&
    payload.repositories_added
  ) {
    for (const repo of payload.repositories_added) {
      if (!repo.id || !repo.full_name) continue;
      await upsertRepo(db, {
        repoId: repo.id,
        installationId,
        fullName: repo.full_name,
        private: repo.private,
        archived: repo.archived,
        defaultBranch: repo.default_branch,
        upstreamState: "connected",
      });
    }
    return;
  }

  if (job.event !== "release" || !installationId) return;

  const repo = payload.repository;
  const release = payload.release;
  if (!repo?.id || !repo.full_name || !release?.id) return;
  if (payload.action === "deleted") {
    await db
      .update(repoReleases)
      .set({
        syncState: "failed",
        syncError: "release_deleted",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(repoReleases.repoId, repo.id),
          eq(repoReleases.githubReleaseId, release.id),
        ),
      );
    return;
  }
  if (release.draft) return;
  if (
    payload.action !== "published" &&
    payload.action !== "edited" &&
    payload.action !== "released" &&
    payload.action !== "prereleased"
  ) {
    return;
  }

  await upsertRepo(db, {
    repoId: repo.id,
    installationId,
    fullName: repo.full_name,
    private: repo.private,
    archived: repo.archived,
    defaultBranch: repo.default_branch,
  });

  // Read per job, not at boot: the App is configured (and rotated) from the console, so a
  // worker that captured the config at startup would go stale after the first change.
  const config = await requireGithubConfig(db);
  const client = new GithubAppClient(config);
  const fullRelease = await client.getRelease(
    repo.full_name,
    release.id,
    installationId,
  );

  const synced = await syncRelease({
    db,
    repoId: repo.id,
    installationId,
    release: fullRelease,
    fetchAsset: (asset) =>
      downloadReleaseAsset(client, repo.full_name!, installationId, asset),
  });

  // A release is the strongest "the repository changed" signal the store gets, and every
  // product it touched may have new brand files. Fire and forget: the sync result is already
  // written, and the refresh records its own failure on the product row.
  for (const productId of synced.productIds) {
    scheduleBrandRefresh(db, productId);
  }
}

/**
 * Fan a push out to every product bound to the repository. A repository can back more than
 * one product (a tag with several extensions), and the throttle collapses bursts.
 */
async function refreshBrandsForRepo(db: Db, repoId: unknown): Promise<void> {
  if (typeof repoId !== "number") return;
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.repoId, repoId));
  for (const row of rows) {
    scheduleBrandRefresh(db, row.id);
  }
}
