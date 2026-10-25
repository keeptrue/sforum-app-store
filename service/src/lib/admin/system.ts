import { getDb, getPool } from "@/db/client";
import { getConfig } from "@/lib/config";
import { getGithubAppView } from "@/lib/github/app-config";
import { windowStartFor } from "@/lib/ratelimit/limiter";
import type { RateLimitRule } from "@/lib/ratelimit/rules";
import { getRuntimeConfig } from "@/lib/settings/runtime";

/**
 * Read-only health probes for the admin console.
 *
 * Every block is loaded through its own `section()` wrapper: an ops page is most useful when
 * one broken subsystem still leaves the rest readable, so a failure becomes a value instead
 * of an exception that takes the whole page down.
 *
 * Raw SQL here on purpose — pg-boss owns the `pgboss` schema and drizzle does not model it,
 * and the aggregates are cheaper as one statement than as ORM round trips.
 */

export type Section<T> = { ok: true; value: T } | { ok: false; error: string };

export type DatabaseHealth = {
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
  /** Host and database name only — never the full URL, which carries the password. */
  connection: { host: string; database: string };
  pool: { total: number; idle: number; waiting: number } | null;
};

export type QueueHealthRow = {
  name: string;
  created: number;
  retry: number;
  active: number;
  failed: number;
};

export type QueuesHealth = { queues: QueueHealthRow[] };

export type RateLimitBucketRow = {
  bucket: string;
  channel: string;
  count: number;
  limit: number;
  windowSeconds: number;
  windowStart: string;
};

export type RateLimitsHealth = {
  /** Buckets whose newest row is the window the rule says is current, highest count first. */
  buckets: RateLimitBucketRow[];
  /** Buckets that hold only past windows (or a channel this deployment no longer limits). */
  staleBuckets: number;
  unknownChannelBuckets: number;
  generatedAt: string;
};

export type WebhookDeliveryRow = {
  deliveryId: string;
  event: string;
  action: string | null;
  status: string;
  error: string | null;
  receivedAt: string;
  processedAt: string | null;
};

export type WebhooksHealth = {
  recent: WebhookDeliveryRow[];
  byStatus: Record<string, number>;
  total: number;
};

export type TableCounts = {
  accounts: number;
  products: number;
  releaseVersions: number;
  releaseAssets: number;
  assets: number;
  auditLog: number;
};

export type IssuerSummary = {
  issuerKey: string;
  displayName: string;
  status: string;
};

/** Presence and identity only: no secret, no key material, no ciphertext. */
export type GithubAppSummary = {
  appId: number | null;
  slug: string | null;
  apiBaseUrl: string;
  keyCount: number;
  webhookSecretSet: boolean;
  lastVerifiedAt: string | null;
  lastError: string | null;
  /** Set when the stored row cannot be decrypted with the current keyring. */
  readError: string | null;
};

export type RuntimeSettingsSummary = {
  publicUrl: string;
  /** Which layer answered: the console row, or the `STORE_PUBLIC_URL` seed. */
  source: "database" | "env";
  updatedAt: string | null;
};

export type ConfigHealth = {
  /** Effective public URL, so an operator can compare it with the address bar. */
  runtime: RuntimeSettingsSummary | null;
  runtimeError: string | null;
  /** Never carries `client_secret*` columns — the query below does not select them. */
  issuers: { total: number; active: number; items: IssuerSummary[] } | null;
  issuersError: string | null;
  /** `null` when the App is not configured at all. */
  github: GithubAppSummary | null;
  githubError: string | null;
  setupTokenConfigured: boolean;
};

export type SystemHealth = {
  generatedAt: string;
  database: Section<DatabaseHealth>;
  queues: Section<QueuesHealth>;
  rateLimits: Section<RateLimitsHealth>;
  webhooks: Section<WebhooksHealth>;
  tables: Section<TableCounts>;
  config: Section<ConfigHealth>;
};

export type HealthTone = "ok" | "warn" | "error";

export type HealthSummary = { tone: HealthTone; parts: string[]; text: string };

/**
 * Error text reaches the browser, so strip anything that looks like a credential. A driver
 * message can embed the connection string, and this page is exactly where that would leak.
 */
export function redactSecrets(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "<database-url>")
    .replace(/(password|secret|token)=[^\s&;]+/gi, "$1=<redacted>")
    .replace(/\/\/[^\s/@:]+:[^\s/@]*@/g, "//<redacted>@");
}

function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = redactSecrets(raw).trim();
  return (cleaned || "未知错误").slice(0, 200);
}

async function section<T>(load: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, value: await load() };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

export function describeConnection(databaseUrl: string): { host: string; database: string } {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    database: url.pathname.replace(/^\/+/, "") || "(default)",
  };
}

async function loadDatabase(): Promise<DatabaseHealth> {
  const connection = describeConnection(getConfig().databaseUrl);

  let reachable = false;
  let error: string | null = null;
  const started = performance.now();
  try {
    await getPool().query("select 1");
    reachable = true;
  } catch (probeError) {
    error = describeError(probeError);
  }
  const latencyMs = reachable ? Math.round(performance.now() - started) : null;

  // Pool counters are informational; a closed/absent pool must not fail the probe result.
  let pool: DatabaseHealth["pool"] = null;
  try {
    const current = getPool();
    pool = {
      total: current.totalCount,
      idle: current.idleCount,
      waiting: current.waitingCount,
    };
  } catch {
    pool = null;
  }

  return { reachable, latencyMs, error, connection, pool };
}

/**
 * `pgboss.job` is the partitioned parent, so it covers per-queue partitions as well as the
 * shared `job_common` table. Queue names are unioned from `job` too: a job can outlive a
 * dropped queue row, and showing the backlog matters more than the registry being tidy.
 */
const QUEUES_SQL = `
  with names as (
    select name from pgboss.queue
    union
    select distinct name from pgboss.job
  )
  select
    n.name,
    count(j.id) filter (where j.state = 'created')::int as created,
    count(j.id) filter (where j.state = 'retry')::int as retry,
    count(j.id) filter (where j.state = 'active')::int as active,
    count(j.id) filter (where j.state = 'failed')::int as failed
  from names n
  left join pgboss.job j
    on j.name = n.name
   and j.state in ('created', 'retry', 'active', 'failed')
  -- pg-boss keeps internal queues (__pgboss__send-it); they are library plumbing, not ours.
  where left(n.name, 10) <> '__pgboss__'
  group by n.name
  order by n.name
`;

async function loadQueues(): Promise<QueuesHealth> {
  const { rows } = await getPool().query<QueueHealthRow>(QUEUES_SQL);
  return {
    queues: rows.map((row) => ({
      name: row.name,
      created: Number(row.created),
      retry: Number(row.retry),
      active: Number(row.active),
      failed: Number(row.failed),
    })),
  };
}

const RATE_LIMIT_LATEST_SQL = `
  select distinct on (bucket) bucket, window_start, count
  from rate_limits
  order by bucket, window_start desc
`;

/**
 * `rate_limits` is a fixed-window counter: one row per (bucket, window start) and no event
 * stream, so a trend line cannot be drawn from it without inventing history. We therefore
 * resolve each bucket's *current* window exactly — the bucket prefix names the channel, and
 * the channel owns the window length — and drop rows from earlier windows.
 */
async function loadRateLimits(now: Date): Promise<RateLimitsHealth> {
  const { rows } = await getPool().query<{
    bucket: string;
    window_start: Date;
    count: number;
  }>(RATE_LIMIT_LATEST_SQL);

  // Effective limits, not the env defaults: the panel must explain the numbers the limiter
  // is actually enforcing, including a console override.
  const rules = (await getRuntimeConfig(getDb())).rateLimits as Record<
    string,
    RateLimitRule | undefined
  >;
  const buckets: RateLimitBucketRow[] = [];
  let staleBuckets = 0;
  let unknownChannelBuckets = 0;

  for (const row of rows) {
    const channel = row.bucket.split(":")[0] ?? "";
    const rule = rules[channel];
    if (!rule) {
      unknownChannelBuckets += 1;
      continue;
    }
    const currentStart = windowStartFor(now, rule.windowSeconds);
    if (currentStart.getTime() !== new Date(row.window_start).getTime()) {
      staleBuckets += 1;
      continue;
    }
    buckets.push({
      bucket: row.bucket,
      channel,
      count: Number(row.count),
      limit: rule.limit,
      windowSeconds: rule.windowSeconds,
      windowStart: currentStart.toISOString(),
    });
  }

  buckets.sort((a, b) => b.count - a.count || a.bucket.localeCompare(b.bucket));

  return {
    buckets: buckets.slice(0, 10),
    staleBuckets,
    unknownChannelBuckets,
    generatedAt: now.toISOString(),
  };
}

async function loadWebhooks(): Promise<WebhooksHealth> {
  const pool = getPool();
  const [recent, counts] = await Promise.all([
    pool.query<{
      delivery_id: string;
      event: string;
      action: string | null;
      status: string;
      error: string | null;
      received_at: Date;
      processed_at: Date | null;
    }>(
      `select delivery_id, event, action, status, error, received_at, processed_at
         from webhook_deliveries
        order by received_at desc
        limit 10`,
    ),
    pool.query<{ status: string; count: number }>(
      `select status, count(*)::int as count from webhook_deliveries group by status`,
    ),
  ]);

  const byStatus: Record<string, number> = { received: 0, processed: 0, failed: 0 };
  let total = 0;
  for (const row of counts.rows) {
    byStatus[row.status] = Number(row.count);
    total += Number(row.count);
  }

  return {
    recent: recent.rows.map((row) => ({
      deliveryId: row.delivery_id,
      event: row.event,
      action: row.action,
      status: row.status,
      error: row.error,
      receivedAt: new Date(row.received_at).toISOString(),
      processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : null,
    })),
    byStatus,
    total,
  };
}

/** One statement, six scalar subqueries: the page must not grow a round trip per table. */
const TABLE_COUNTS_SQL = `
  select
    (select count(*)::int from accounts) as accounts,
    (select count(*)::int from products) as products,
    (select count(*)::int from release_versions) as release_versions,
    (select count(*)::int from release_assets) as release_assets,
    (select count(*)::int from assets) as assets,
    (select count(*)::int from audit_log) as audit_log
`;

async function loadTableCounts(): Promise<TableCounts> {
  const { rows } = await getPool().query<{
    accounts: number;
    products: number;
    release_versions: number;
    release_assets: number;
    assets: number;
    audit_log: number;
  }>(TABLE_COUNTS_SQL);
  const row = rows[0];
  return {
    accounts: Number(row?.accounts ?? 0),
    products: Number(row?.products ?? 0),
    releaseVersions: Number(row?.release_versions ?? 0),
    releaseAssets: Number(row?.release_assets ?? 0),
    assets: Number(row?.assets ?? 0),
    auditLog: Number(row?.audit_log ?? 0),
  };
}

async function loadConfigHealth(): Promise<ConfigHealth> {
  const config = getConfig();

  let issuers: ConfigHealth["issuers"] = null;
  let issuersError: string | null = null;
  try {
    // Deliberately narrow column list: the ciphertext and kid must never reach a response.
    const { rows } = await getPool().query<{
      issuer_key: string;
      display_name: string;
      status: string;
    }>(
      `select issuer_key, display_name, status from oauth_issuers order by display_name`,
    );
    issuers = {
      total: rows.length,
      active: rows.filter((row) => row.status === "active").length,
      items: rows.map((row) => ({
        issuerKey: row.issuer_key,
        displayName: row.display_name,
        status: row.status,
      })),
    };
  } catch (error) {
    issuersError = describeError(error);
  }

  let github: ConfigHealth["github"] = null;
  let githubError: string | null = null;
  try {
    const view = await getGithubAppView(getDb());
    if (view.configured) {
      github = {
        appId: view.appId,
        slug: view.slug,
        apiBaseUrl: view.apiBaseUrl,
        keyCount: view.keys.length,
        webhookSecretSet: view.webhookSecretSet,
        lastVerifiedAt: view.lastVerifiedAt,
        lastError: view.lastError,
        readError: view.readError,
      };
    }
  } catch (error) {
    githubError = describeError(error);
  }

  // Runtime settings resolve through their own try: a database that is down must still leave
  // the seed value readable instead of blanking the whole config section.
  let runtime: RuntimeSettingsSummary | null = null;
  let runtimeError: string | null = null;
  try {
    const resolved = await getRuntimeConfig(getDb());
    runtime = {
      publicUrl: resolved.publicUrl,
      source: resolved.publicUrlSource,
      updatedAt: resolved.updatedAt ? resolved.updatedAt.toISOString() : null,
    };
  } catch (error) {
    runtimeError = describeError(error);
  }

  return {
    runtime,
    runtimeError,
    issuers,
    issuersError,
    github,
    githubError,
    setupTokenConfigured: config.adminSetupToken !== null,
  };
}

export async function loadSystemHealth(
  options: { now?: Date } = {},
): Promise<SystemHealth> {
  const now = options.now ?? new Date();

  const [database, queues, rateLimits, webhooks, tables, config] = await Promise.all([
    section(loadDatabase),
    section(loadQueues),
    section(() => loadRateLimits(now)),
    section(loadWebhooks),
    section(loadTableCounts),
    section(loadConfigHealth),
  ]);

  return {
    generatedAt: now.toISOString(),
    database,
    queues,
    rateLimits,
    webhooks,
    tables,
    config,
  };
}

/** Human labels for the panels, reused by the summary line so both stay in sync. */
export const SECTION_LABELS = {
  database: "数据库",
  queues: "队列",
  rateLimits: "限流",
  webhooks: "Webhook",
  tables: "表计数",
  config: "配置自检",
} as const;

export function failedSections(health: SystemHealth): string[] {
  const failures: string[] = [];
  for (const key of Object.keys(SECTION_LABELS) as (keyof typeof SECTION_LABELS)[]) {
    if (!health[key].ok) failures.push(SECTION_LABELS[key]);
  }
  return failures;
}

/**
 * The one-line verdict at the top of the page. Order is deliberate: database first (nothing
 * else means much without it), then the two queues of work that can silently stall.
 */
export function summarizeHealth(health: SystemHealth): HealthSummary {
  const parts: string[] = [];
  let tone: HealthTone = "ok";
  const warn = (message: string) => {
    parts.push(message);
    if (tone === "ok") tone = "warn";
  };
  const fatal = (message: string) => {
    parts.push(message);
    tone = "error";
  };

  if (!health.database.ok) fatal("数据库读取失败");
  else if (!health.database.value.reachable) fatal("数据库不可达");
  else parts.push(`数据库正常（${health.database.value.latencyMs ?? 0} ms）`);

  if (!health.queues.ok) warn("队列读取失败");
  else {
    const queues = health.queues.value.queues;
    const backlog = queues.reduce((sum, q) => sum + q.created + q.retry + q.active, 0);
    const failed = queues.reduce((sum, q) => sum + q.failed, 0);
    if (failed > 0) warn(`${failed} 个 job 失败`);
    if (backlog > 0) warn(`${backlog} 个 job 待处理`);
    if (failed === 0 && backlog === 0) parts.push(`${queues.length} 个队列无积压`);
  }

  if (!health.webhooks.ok) warn("webhook 读取失败");
  else {
    const failed = health.webhooks.value.byStatus.failed ?? 0;
    if (failed > 0) warn(`${failed} 个 webhook 失败`);
    else parts.push("webhook 无失败");
  }

  if (!health.rateLimits.ok) warn("限流读取失败");
  else {
    const saturated = health.rateLimits.value.buckets.filter((b) => b.count >= b.limit).length;
    if (saturated > 0) warn(`${saturated} 个限流桶达到上限`);
  }

  if (!health.tables.ok) warn("表计数读取失败");

  if (!health.config.ok) warn("配置读取失败");
  else {
    const config = health.config.value;
    if (config.runtimeError) warn("对外地址读取失败");
    if (config.issuersError) warn("issuer 读取失败");
    else if ((config.issuers?.active ?? 0) === 0) warn("未配置登录方式");
  }

  return { tone, parts, text: parts.join(" · ") };
}
