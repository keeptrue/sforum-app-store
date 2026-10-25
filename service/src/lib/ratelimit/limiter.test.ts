import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import { consumeRateLimit, retryAfterSeconds, windowStartFor } from "./limiter";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

let db: Db;

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
  await getPool().query("TRUNCATE TABLE rate_limits RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  await getPool().query("TRUNCATE TABLE rate_limits RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await closeDb();
});

const rule = { limit: 3, windowSeconds: 300 };

describe("fixed window helpers", () => {
  test("windowStartFor floors to the window size", () => {
    const start = windowStartFor(new Date("2026-10-24T12:07:31.000Z"), 300);
    expect(start.toISOString()).toBe("2026-10-24T12:05:00.000Z");
  });

  test("retryAfterSeconds counts down to the window end", () => {
    expect(retryAfterSeconds(new Date("2026-10-24T12:07:31.000Z"), 300)).toBe(149);
    expect(retryAfterSeconds(new Date("2026-10-24T12:10:00.000Z"), 300)).toBe(300);
  });
});

describe("consumeRateLimit", () => {
  test("allows up to the limit, then blocks with a retry window", async () => {
    const now = new Date("2026-10-24T12:07:31.000Z");
    for (let i = 1; i <= 3; i += 1) {
      const decision = await consumeRateLimit(db, "login:ip:1.2.3.4", rule, {
        now,
        sweep: false,
      });
      expect(decision).toEqual({ ok: true, remaining: 3 - i, degraded: false });
    }

    const blocked = await consumeRateLimit(db, "login:ip:1.2.3.4", rule, {
      now,
      sweep: false,
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterSeconds).toBe(149);
  });

  test("a new window starts from zero", async () => {
    const first = new Date("2026-10-24T12:09:59.000Z");
    for (let i = 0; i < 3; i += 1) {
      await consumeRateLimit(db, "submit:account:a", rule, { now: first, sweep: false });
    }
    const blocked = await consumeRateLimit(db, "submit:account:a", rule, {
      now: first,
      sweep: false,
    });
    expect(blocked.ok).toBe(false);

    const next = await consumeRateLimit(db, "submit:account:a", rule, {
      now: new Date("2026-10-24T12:10:00.000Z"),
      sweep: false,
    });
    expect(next.ok).toBe(true);
  });

  test("buckets are independent", async () => {
    const now = new Date("2026-10-24T12:07:31.000Z");
    for (let i = 0; i < 3; i += 1) {
      await consumeRateLimit(db, "login:ip:1.2.3.4", rule, { now, sweep: false });
    }
    const other = await consumeRateLimit(db, "login:ip:5.6.7.8", rule, {
      now,
      sweep: false,
    });
    expect(other).toEqual({ ok: true, remaining: 2, degraded: false });
  });

  test("fails open when the counter is unavailable", async () => {
    const broken = {
      insert: () => {
        throw new Error("connection refused");
      },
    } as unknown as Db;
    const decision = await consumeRateLimit(broken, "login:ip:9.9.9.9", rule, {
      sweep: false,
    });
    expect(decision).toEqual({ ok: true, remaining: null, degraded: true });
  });
});
