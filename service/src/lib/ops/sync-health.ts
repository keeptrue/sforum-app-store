import { getPool } from "@/db/client";

/**
 * Is anything actually consuming the GitHub webhook queue?
 *
 * The webhook route only records the delivery and enqueues it; all release work happens in
 * the worker. When that process is missing the store still looks healthy from the outside —
 * `/api/health` is the web process, and the catalog is a DB read — so the only visible
 * symptom is a queue that never drains. This probe turns that into a value both the admin
 * console and the developer portal can show.
 *
 * A job is "stale" only while it is still `created` and nothing is `active`: a long release
 * sync (four platform packages) legitimately leaves later jobs waiting behind it, and
 * counting that as "worker is down" would cry wolf on every release.
 */

export const SYNC_QUEUE = "github-webhook";

/** Two minutes is long enough for a release sync to start, short enough to notice. */
export const SYNC_STALE_AFTER_MS = 120_000;

export type SyncQueueHealth = {
  /** Jobs that have not been picked up yet. */
  pending: number;
  /** Jobs currently being processed; a non-zero value proves the worker is alive. */
  active: number;
  oldestQueuedAt: string | null;
  stale: boolean;
};

type SyncQueueRow = {
  pending: number;
  active: number;
  oldest_queued_at: Date | string | null;
};

const SYNC_QUEUE_SQL = `
  select
    count(*) filter (where state = 'created')::int as pending,
    count(*) filter (where state = 'active')::int as active,
    min(created_on) filter (where state = 'created') as oldest_queued_at
  from pgboss.job
  where name = $1
`;

export async function getSyncQueueHealth(
  now: Date = new Date(),
): Promise<SyncQueueHealth> {
  const { rows } = await getPool().query<SyncQueueRow>(SYNC_QUEUE_SQL, [SYNC_QUEUE]);
  const row = rows[0];
  const pending = Number(row?.pending ?? 0);
  const active = Number(row?.active ?? 0);
  const oldest =
    row?.oldest_queued_at === null || row?.oldest_queued_at === undefined
      ? null
      : new Date(row.oldest_queued_at);

  const stale =
    pending > 0 &&
    active === 0 &&
    oldest !== null &&
    now.getTime() - oldest.getTime() > SYNC_STALE_AFTER_MS;

  return {
    pending,
    active,
    oldestQueuedAt: oldest?.toISOString() ?? null,
    stale,
  };
}

/** The one sentence the developer portal shows; `null` means there is nothing to say. */
export function syncAlertText(
  health: SyncQueueHealth,
  now: Date = new Date(),
): string | null {
  if (!health.stale || health.oldestQueuedAt === null) return null;

  const waitedMinutes = Math.max(
    1,
    Math.floor((now.getTime() - Date.parse(health.oldestQueuedAt)) / 60_000),
  );
  return `版本同步服务似乎未运行：${health.pending} 个 GitHub 事件已排队 ${waitedMinutes} 分钟。新版本不会自动上线。`;
}
