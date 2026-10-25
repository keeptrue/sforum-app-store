import { eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import { githubInstallations } from "@/db/schema";

export type InstallationRecord = {
  installationId: number;
  accountId: string | null;
  accountLogin: string;
};

/**
 * Upsert an installation row. Kept out of the setup route so the route stays transport
 * only (AGENTS: SQL belongs in the store/domain layer).
 */
export async function recordInstallation(
  db: Db,
  input: InstallationRecord,
): Promise<void> {
  const existing = await db
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, input.installationId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(githubInstallations)
      .set({
        accountId: input.accountId,
        accountLogin: input.accountLogin,
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(githubInstallations.installationId, input.installationId));
    return;
  }

  await db.insert(githubInstallations).values({
    installationId: input.installationId,
    accountId: input.accountId,
    accountLogin: input.accountLogin,
    status: "active",
  });
}
