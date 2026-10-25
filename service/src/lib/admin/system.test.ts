import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import { resetConfigForTests } from "@/lib/config";
import { windowStartFor } from "@/lib/ratelimit/limiter";
import { loadSystemHealth, redactSecrets, summarizeHealth } from "./system";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

const expected = new URL(TEST_DATABASE_URL);

let db: Db;

/** pg-boss owns this schema; the health page reads it directly, so the test must create it. */
async function ensurePgbossSchema(): Promise<void> {
  await getPool().query(`
    create schema if not exists pgboss;
    create table if not exists pgboss.queue (name text primary key);
    create table if not exists pgboss.job (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      state text not null default 'created'
    );
  `);
}

async function truncateAll(): Promise<void> {
  await getPool().query(`
    truncate table
      webhook_deliveries, rate_limits, audit_log,
      release_assets, release_versions, products, repo_releases, assets,
      accounts, oauth_issuers
    restart identity cascade
  `);
  await getPool().query("truncate table pgboss.job, pgboss.queue");
}

async function seedIssuer(): Promise<void> {
  await getPool().query(
    `insert into oauth_issuers
       (issuer_key, display_name, base_url, client_id, client_secret_ciphertext, client_secret_kid, status)
     values ('official', '官方论坛', 'https://forum.example', 'client-id-0001', 'ciphertext', 'k1', 'active')`,
  );
}

/** Minimal FK chain: account → product → release version → release asset, plus one asset row. */
async function seedCatalog(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `insert into accounts (issuer_key, sub) values ('official', 'sub-1'), ('official', 'sub-2')`,
  );
  await pool.query(
    `insert into assets (sha256, mime, width, height, bytes, storage_key)
     values (repeat('a', 64), 'image/png', 16, 16, 512, 'aa/aa.png')`,
  );
  await pool.query(
    `insert into repo_releases (repo_id, github_release_id, tag) values (1, 100, 'v1.0.0')`,
  );
  await pool.query(
    `insert into products (extension_id, name, kind, slug, owner_account_id)
     select 'com.example.one', 'One', 'plugin', 'one', id from accounts order by sub limit 1`,
  );
  await pool.query(
    `insert into release_versions (product_id, repo_release_id, version, channel, sforum_version_constraint)
     select p.id, r.id, '1.0.0', 'stable', '>=1.0.0' from products p, repo_releases r limit 1`,
  );
  await pool.query(
    `insert into release_assets
       (release_version_id, os, arch, filename, size, sha256, upstream_asset_id, detection_source)
     select v.id, 'linux', 'amd64', 'one.zip', 1024, repeat('b', 64), 1, 'header'
       from release_versions v limit 1`,
  );
  await pool.query(
    `insert into audit_log (action, target_type) values ('admin.test', 'product')`,
  );
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.STORE_PUBLIC_URL = "http://127.0.0.1:3000";
  process.env.STORE_SESSION_SECRET = "s".repeat(64);
  process.env.STORE_DOWNLOAD_SECRET = "d".repeat(64);
  process.env.STORE_SECRET_KEYS = `test1:${Buffer.alloc(32, 5).toString("base64")}`;
  resetConfigForTests();

  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
  await ensurePgbossSchema();
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
  resetConfigForTests();
});

describe("table counts", () => {
  test("one aggregate query returns the exact row counts", async () => {
    await seedCatalog();
    const health = await loadSystemHealth();

    expect(health.tables.ok).toBe(true);
    if (!health.tables.ok) return;
    expect(health.tables.value).toEqual({
      accounts: 2,
      products: 1,
      releaseVersions: 1,
      releaseAssets: 1,
      assets: 1,
      auditLog: 1,
    });
  });

  test("an empty database counts as zero rather than failing", async () => {
    const health = await loadSystemHealth();
    expect(health.tables.ok).toBe(true);
    if (!health.tables.ok) return;
    expect(health.tables.value.products).toBe(0);
    expect(health.tables.value.auditLog).toBe(0);
  });
});

describe("webhook deliveries", () => {
  test("groups by status and keeps the ten newest deliveries", async () => {
    const rows: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const status = i === 0 ? "failed" : i === 1 ? "received" : "processed";
      rows.push(
        `('delivery-${String(i).padStart(2, "0")}', 'release', 'published', '${status}',
          '2026-10-25T09:${String(i).padStart(2, "0")}:00Z')`,
      );
    }
    await getPool().query(
      `insert into webhook_deliveries (delivery_id, event, action, status, received_at)
       values ${rows.join(",")}`,
    );

    const health = await loadSystemHealth();
    expect(health.webhooks.ok).toBe(true);
    if (!health.webhooks.ok) return;

    expect(health.webhooks.value.byStatus).toEqual({
      received: 1,
      processed: 10,
      failed: 1,
    });
    expect(health.webhooks.value.total).toBe(12);
    expect(health.webhooks.value.recent).toHaveLength(10);
    expect(health.webhooks.value.recent[0]?.deliveryId).toBe("delivery-11");
  });
});

describe("queue backlog", () => {
  test("registered queues with no jobs report zeros instead of throwing", async () => {
    await getPool().query(
      `insert into pgboss.queue (name) values ('github-webhook'), ('release-sync'), ('__pgboss__send-it')`,
    );

    const health = await loadSystemHealth();
    expect(health.queues.ok).toBe(true);
    if (!health.queues.ok) return;

    expect(health.queues.value.queues).toEqual([
      { name: "github-webhook", created: 0, retry: 0, active: 0, failed: 0 },
      { name: "release-sync", created: 0, retry: 0, active: 0, failed: 0 },
    ]);
  });

  test("groups unfinished jobs by state and ignores completed and internal queues", async () => {
    const pool = getPool();
    await pool.query(
      `insert into pgboss.queue (name) values ('github-webhook'), ('__pgboss__send-it')`,
    );
    await pool.query(
      `insert into pgboss.job (name, state) values
         ('github-webhook', 'created'),
         ('github-webhook', 'created'),
         ('github-webhook', 'retry'),
         ('github-webhook', 'active'),
         ('github-webhook', 'failed'),
         ('github-webhook', 'completed'),
         ('__pgboss__send-it', 'failed')`,
    );

    const health = await loadSystemHealth();
    expect(health.queues.ok).toBe(true);
    if (!health.queues.ok) return;

    expect(health.queues.value.queues).toEqual([
      { name: "github-webhook", created: 2, retry: 1, active: 1, failed: 1 },
    ]);
  });

  test("no queue registry at all is an empty list", async () => {
    const health = await loadSystemHealth();
    expect(health.queues.ok).toBe(true);
    if (!health.queues.ok) return;
    expect(health.queues.value.queues).toEqual([]);
  });

  test("a broken queue schema fails only the queue block", async () => {
    await getPool().query("drop schema pgboss cascade");
    try {
      const health = await loadSystemHealth();

      expect(health.queues.ok).toBe(false);
      if (!health.queues.ok) expect(health.queues.error).toContain("pgboss");
      expect(health.tables.ok).toBe(true);
      expect(health.webhooks.ok).toBe(true);
      expect(health.database.ok).toBe(true);
      expect(summarizeHealth(health).text).toContain("队列读取失败");
    } finally {
      await ensurePgbossSchema();
    }
  });
});

describe("rate limit windows", () => {
  test("keeps only each bucket's current window, highest count first", async () => {
    const now = new Date("2026-10-25T10:07:31.000Z");
    const loginStart = windowStartFor(now, 300);
    const submitStart = windowStartFor(now, 3600);
    const staleLoginStart = new Date(loginStart.getTime() - 300_000);

    await getPool().query(
      `insert into rate_limits (bucket, window_start, count) values
         ('login:ip:1.2.3.4', $1, 7),
         ('login:ip:1.2.3.4', $2, 99),
         ('login:ip:5.6.7.8', $2, 4),
         ('submit:account:abc', $3, 3),
         ('mystery:ip:9.9.9.9', $1, 42)`,
      [loginStart, staleLoginStart, submitStart],
    );

    const health = await loadSystemHealth({ now });
    expect(health.rateLimits.ok).toBe(true);
    if (!health.rateLimits.ok) return;

    const { buckets, staleBuckets, unknownChannelBuckets } = health.rateLimits.value;
    expect(buckets.map((bucket) => [bucket.bucket, bucket.count])).toEqual([
      ["login:ip:1.2.3.4", 7],
      ["submit:account:abc", 3],
    ]);
    expect(buckets[0]?.limit).toBe(10);
    expect(buckets[0]?.windowStart).toBe(loginStart.toISOString());
    expect(staleBuckets).toBe(1);
    expect(unknownChannelBuckets).toBe(1);
  });
});

describe("credential hygiene", () => {
  test("the payload carries host and database name but never the connection string", async () => {
    await seedIssuer();
    const health = await loadSystemHealth();
    const serialised = JSON.stringify(health);

    expect(serialised).not.toContain("postgres://");
    expect(serialised).not.toContain("postgresql://");
    if (expected.password) expect(serialised).not.toContain(expected.password);
    expect(serialised).not.toContain("ciphertext");
    expect(serialised).not.toContain("client_secret");

    expect(health.database.ok).toBe(true);
    if (!health.database.ok) return;
    expect(health.database.value.reachable).toBe(true);
    expect(health.database.value.connection).toEqual({
      host: expected.hostname,
      database: expected.pathname.replace(/^\/+/, ""),
    });
  });

  test("redactSecrets strips URLs, passwords and key=value secrets", () => {
    const raw =
      "connect postgres://store:store_dev_only@127.0.0.1:15432/db failed password=hunter2 token=abc";
    const cleaned = redactSecrets(raw);
    expect(cleaned).not.toContain("store_dev_only");
    expect(cleaned).not.toContain("hunter2");
    expect(cleaned).not.toContain("abc");
    expect(cleaned).toContain("<database-url>");
  });
});

describe("summary line", () => {
  test("reports a healthy store in one line", async () => {
    await seedIssuer();
    const health = await loadSystemHealth();
    const summary = summarizeHealth(health);

    expect(summary.tone).toBe("ok");
    expect(summary.text).toContain("数据库正常");
    expect(summary.text).toContain("个队列无积压");
    expect(summary.text).toContain("webhook 无失败");
  });

  test("surfaces a failed webhook and a missing login method as warnings", async () => {
    await getPool().query(
      `insert into webhook_deliveries (delivery_id, event, status) values ('d-1', 'release', 'failed')`,
    );
    const health = await loadSystemHealth();
    const summary = summarizeHealth(health);

    expect(summary.tone).toBe("warn");
    expect(summary.text).toContain("1 个 webhook 失败");
    expect(summary.text).toContain("未配置登录方式");
  });
});
