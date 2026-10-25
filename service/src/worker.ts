import { getDb } from "@/db/client";
import { getConfig } from "@/lib/config";
import { loadGithubConfig } from "@/lib/github/app-config";
import { markWebhookDelivery } from "@/lib/github/deliveries";
import {
  handleGithubWebhookJob,
  type GithubWebhookJob,
} from "@/lib/github/jobs";
import { sweepStaleBrands } from "@/lib/products/brand-sweep";
import { getBoss, stopBoss } from "@/lib/queue";

/**
 * Daily brand sweep, in UTC. Off the hour on purpose: a store that also runs backups or log
 * rotation at 04:00 should not stack a few hundred outbound GitHub reads on the same minute.
 */
const BRAND_SWEEP_CRON = "17 4 * * *";

async function main() {
  // `getConfig()` still gates the env the worker genuinely needs (database, keyring). The
  // GitHub App is console configuration now: an unconfigured App must not keep the worker from
  // starting, because the queue also carries deliveries that arrived before it was set up.
  getConfig();
  const db = getDb();

  const github = await loadGithubConfig(db).catch(() => null);
  if (!github) {
    console.warn("[worker] GitHub App is not configured; release jobs will fail until it is");
  }

  const boss = await getBoss();

  await boss.work<GithubWebhookJob>("github-webhook", async (jobs) => {
    for (const job of jobs) {
      const data = job.data;
      try {
        await handleGithubWebhookJob(data);
        await markWebhookDelivery(db, data.deliveryId, "processed");
      } catch (error) {
        await markWebhookDelivery(
          db,
          data.deliveryId,
          "failed",
          error instanceof Error ? error.message : "job_failed",
        );
        throw error;
      }
    }
  });

  await boss.work("brand-sweep", async () => {
    const result = await sweepStaleBrands(db);
    console.log(
      `[worker] brand sweep scanned=${result.scanned} refreshed=${result.refreshed} failed=${result.failed}`,
    );
  });

  // Idempotent upsert: restarting the worker does not duplicate the plan.
  await boss.schedule("brand-sweep", BRAND_SWEEP_CRON, {}, { tz: "UTC" });

  console.log("[worker] ready");

  const shutdown = async () => {
    await stopBoss();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[worker] fatal", error);
  process.exit(1);
});
