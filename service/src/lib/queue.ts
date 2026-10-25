import { PgBoss } from "pg-boss";

let bossPromise: Promise<PgBoss> | null = null;

export type QueueName = "github-webhook" | "release-sync" | "brand-sweep";

export async function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required");

    bossPromise = (async () => {
      const boss = new PgBoss({ connectionString });
      boss.on("error", (error: Error) => console.error("[queue] error", error));
      await boss.start();
      await boss.createQueue("github-webhook");
      await boss.createQueue("release-sync");
      await boss.createQueue("brand-sweep");
      return boss;
    })();
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
