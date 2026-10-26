import { PgBoss } from "pg-boss";

let bossPromise: Promise<PgBoss> | null = null;

export type QueueName = "github-webhook" | "release-sync" | "brand-sweep";

/**
 * Retry policy for webhook jobs.
 *
 * Why it exists: `syncRelease` aborts on a retryable asset failure — a 5xx, a 429, a socket
 * timeout, an installation token rejected mid-rotation — and leaves the release row `failed`.
 * The alternative, and what the code did before, was to record `asset_failed` and hold every
 * version in the tag; `needs_attention` is terminal, so those version numbers could only come
 * back as a patch release. A minute of GitHub being down must not cost a version number.
 *
 * The budget: five retries with exponential backoff from 60 s (60, 120, 240, 480, then 600
 * capped) rides out roughly half an hour, which is the shape of GitHub's 5xx windows, and then
 * stops. Deliberately not infinite: a genuinely broken release would otherwise re-run until
 * the 14-day retention expires.
 *
 * `expireInSeconds: 1800`: one asset download is already bounded at 90 s by the
 * `AbortSignal.timeout` in `GithubAppClient.downloadAsset`, and a release carries a checksums
 * file plus one ZIP per platform — a ten-platform tag is therefore up to ~16.5 min of pure
 * transfer before unzip, hashing and the database work. pg-boss defaults to 900 s, which would
 * expire a job that is still making progress and restart it from the first asset; 1800 s keeps
 * the headroom and still reclaims a genuinely stuck job long before retention.
 */
const WEBHOOK_QUEUE_OPTIONS = {
  retryLimit: 5,
  retryDelay: 60,
  retryBackoff: true,
  retryDelayMax: 600,
  expireInSeconds: 1800,
};

export async function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required");

    bossPromise = (async () => {
      const boss = new PgBoss({ connectionString });
      boss.on("error", (error: Error) => console.error("[queue] error", error));
      await boss.start();
      await boss.createQueue("github-webhook", WEBHOOK_QUEUE_OPTIONS);
      // `create_queue()` inserts with `ON CONFLICT DO NOTHING`, so a queue row that already
      // exists — every deployment that ran before this policy — keeps its old settings
      // (retry_limit 2, retry_delay 0, expire 900). `updateQueue` is what actually applies the
      // policy there; without it the retry configuration would reach a fresh database only and
      // would silently do nothing in production.
      await boss.updateQueue("github-webhook", WEBHOOK_QUEUE_OPTIONS);
      await boss.createQueue("release-sync");
      await boss.createQueue("brand-sweep");
      return boss;
    })().catch((error) => {
      // A rejection must not be cached. One bad start — a database that was not up yet, a
      // failed `updateQueue` — would otherwise be replayed to every later `enqueue` in this
      // process, so the webhook route would keep answering 500 until someone restarted the
      // worker. Clearing the slot makes the next call try again.
      bossPromise = null;
      throw error;
    });
  }
  return bossPromise;
}

export async function enqueue(
  queue: QueueName,
  data: Record<string, unknown>,
): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(queue, data);
}

export async function stopBoss(): Promise<void> {
  if (!bossPromise) return;
  const boss = await bossPromise;
  await boss.stop();
  bossPromise = null;
}
