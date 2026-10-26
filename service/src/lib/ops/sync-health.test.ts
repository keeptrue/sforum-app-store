import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { closeDb, getPool } from "@/db/client";
import { getSyncQueueHealth, syncAlertText } from "./sync-health";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

async function ensurePgbossJobTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    create schema if not exists pgboss;
    create table if not exists pgboss.job (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      state text not null default 'created',
      created_on timestamptz not null default now()
    );
    alter table pgboss.job
      add column if not exists created_on timestamptz not null default now();
  `);
}

async function insertJob(
  state: "created" | "active",
  ageMinutes = 0,
): Promise<void> {
  await getPool().query(
    `insert into pgboss.job (name, state, created_on)
     values ('github-webhook', $1, now() - ($2 || ' minutes')::interval)`,
    [state, ageMinutes],
  );
}

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  await ensurePgbossJobTable();
});

beforeEach(async () => {
  await getPool().query("truncate table pgboss.job");
});

afterAll(async () => {
  await closeDb();
});

describe("sync queue health", () => {
  test("an empty queue is not stale and has nothing to say", async () => {
    const health = await getSyncQueueHealth();
    expect(health).toEqual({
      pending: 0,
      active: 0,
      oldestQueuedAt: null,
      stale: false,
    });
    expect(syncAlertText(health)).toBeNull();
  });

  test("a fresh created job is still waiting normally", async () => {
    await insertJob("created", 0);
    const health = await getSyncQueueHealth();
    expect(health.pending).toBe(1);
    expect(health.stale).toBe(false);
    expect(syncAlertText(health)).toBeNull();
  });

  test("an old created job with no active work means nobody is consuming", async () => {
    await insertJob("created", 10);
    const now = new Date();
    const health = await getSyncQueueHealth(now);

    expect(health.pending).toBe(1);
    expect(health.active).toBe(0);
    expect(health.stale).toBe(true);
    expect(health.oldestQueuedAt).toEqual(expect.any(String));
    expect(syncAlertText(health, now)).toContain("1 个 GitHub 事件");
    expect(syncAlertText(health, now)).toContain("10 分钟");
  });

  test("an active job proves the worker is alive even when others wait", async () => {
    await insertJob("created", 10);
    await insertJob("active", 10);

    const health = await getSyncQueueHealth();
    expect(health.pending).toBe(1);
    expect(health.active).toBe(1);
    expect(health.stale).toBe(false);
    expect(syncAlertText(health)).toBeNull();
  });
});
