import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import { accounts, adminAccounts, auditLog } from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import {
  auditFilterValues,
  auditFilters,
  decodeAuditCursor,
  encodeAuditCursor,
  loadAuditPage,
  parseAuditTrail,
} from "./audit";

/**
 * Integration tests against a real PostgreSQL instance: the whole point of this layer is the
 * keyset boundary and the row-value comparison in SQL, which an in-memory fake would not prove.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

let db: Db;
let adminId: string;
let forumAccountId: string;

const EMPTY = auditFilters({
  actor: "",
  action: "",
  targetType: "",
  from: "",
  to: "",
});

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = TEST_DATABASE_URL;

  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
  // Children first: audit_log references both actor tables, admin_sessions references admins.
  await getPool().query(TRUNCATE_ALL);

  const [admin] = await db
    .insert(adminAccounts)
    .values({
      username: "auditor",
      passwordHash: "scrypt$32768$8$1$c2FsdA==$aGFzaA==",
      displayName: "审计员",
    })
    .returning({ id: adminAccounts.id });
  const [forum] = await db
    .insert(accounts)
    .values({ issuerKey: "test", sub: "1", username: "lin", displayName: "Lin" })
    .returning({ id: accounts.id });

  adminId = admin!.id;
  forumAccountId = forum!.id;
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  // Only the trail is reset: the actor fixtures stay put so every test starts from the same
  // two identities.
  await getPool().query("TRUNCATE TABLE audit_log RESTART IDENTITY");
});

type SeedOptions = {
  action?: string;
  startAt?: Date;
  stepMs?: number;
  actor?: "admin" | "forum" | "none";
  targetType?: string;
};

async function seed(count: number, options: SeedOptions = {}): Promise<void> {
  if (count === 0) return;
  const startAt = options.startAt ?? new Date("2026-10-01T00:00:00.000Z");
  const stepMs = options.stepMs ?? 60_000;
  const actor = options.actor ?? "admin";

  await db.insert(auditLog).values(
    Array.from({ length: count }, (_, index) => ({
      actorAdminId: actor === "admin" ? adminId : null,
      actorAccountId: actor === "forum" ? forumAccountId : null,
      action: options.action ?? "test.page",
      targetType: options.targetType ?? "product",
      targetId: null,
      details: { index },
      ip: "127.0.0.1",
      createdAt: new Date(startAt.getTime() + index * stepMs),
    })),
  );
}

async function collectAllPages(limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await loadAuditPage(db, { filters: EMPTY, cursor, limit });
    ids.push(...page.entries.map((entry) => entry.id));
    if (page.nextCursor === null) return ids;
    cursor = decodeAuditCursor(page.nextCursor);
    expect(cursor).not.toBeNull();
  }
  throw new Error("pagination did not terminate");
}

describe("audit read model", () => {
  test("cursor paging covers every row exactly once, newest first", async () => {
    await seed(120);

    const first = await loadAuditPage(db, { filters: EMPTY, cursor: null });
    expect(first.entries).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();

    const second = await loadAuditPage(db, {
      filters: EMPTY,
      cursor: decodeAuditCursor(first.nextCursor!),
    });
    expect(second.entries).toHaveLength(50);

    const third = await loadAuditPage(db, {
      filters: EMPTY,
      cursor: decodeAuditCursor(second.nextCursor!),
    });
    expect(third.entries).toHaveLength(20);
    expect(third.nextCursor).toBeNull();

    const seen = [...first.entries, ...second.entries, ...third.entries].map((row) => row.id);
    expect(new Set(seen).size).toBe(120);

    // Strictly descending across the whole walk, and the newest row of the seed leads.
    const times = [...first.entries, ...second.entries, ...third.entries].map((row) =>
      row.createdAt.getTime(),
    );
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(first.entries[0]!.details).toEqual({ index: 119 });
  });

  test("a page boundary inside one timestamp neither repeats nor skips rows", async () => {
    // Five rows share an instant: only the id tiebreak can separate them.
    const sameInstant = new Date("2026-10-02T12:00:00.000Z");
    await seed(5, { startAt: sameInstant, stepMs: 0 });

    const ids = await collectAllPages(2);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  test("filters by action, including a partial match", async () => {
    await seed(2, { action: "product.approved" });
    await seed(1, { action: "admin.login.succeeded" });

    const exact = await loadAuditPage(db, {
      filters: auditFilters({ ...blank(), action: "product.approved" }),
    });
    expect(exact.entries).toHaveLength(2);
    expect(exact.entries.every((row) => row.action === "product.approved")).toBe(true);

    const partial = await loadAuditPage(db, {
      filters: auditFilters({ ...blank(), action: "login" }),
    });
    expect(partial.entries).toHaveLength(1);
  });

  test("filters by UTC day range, both ends inclusive", async () => {
    await seed(1, { startAt: new Date("2026-10-18T23:59:59.000Z") });
    await seed(1, { startAt: new Date("2026-10-19T00:00:00.000Z") });
    await seed(1, { startAt: new Date("2026-10-19T23:59:59.000Z") });
    await seed(1, { startAt: new Date("2026-10-20T00:00:00.000Z") });

    const day = await loadAuditPage(db, {
      filters: auditFilters({ ...blank(), from: "2026-10-19", to: "2026-10-19" }),
    });
    expect(day.entries).toHaveLength(2);

    const openEnded = await loadAuditPage(db, {
      filters: auditFilters({ ...blank(), from: "2026-10-20" }),
    });
    expect(openEnded.entries).toHaveLength(1);
    expect(openEnded.entries[0]!.createdAt.toISOString()).toBe("2026-10-20T00:00:00.000Z");
  });

  test("filters by actor across admins, forum accounts and system rows", async () => {
    await seed(1, { actor: "admin", action: "admin.login.succeeded" });
    await seed(1, { actor: "forum", action: "auth.login.succeeded" });
    await seed(1, { actor: "none", action: "github.webhook.received" });

    const byAdmin = await loadAuditPage(db, {
      filters: auditFilters({ ...blank(), actor: "audit" }),
    });
    expect(byAdmin.entries).toHaveLength(1);
    expect(byAdmin.entries[0]!.actor).toEqual({ kind: "admin", label: "审计员" });

    const byForum = await loadAuditPage(db, {
      filters: auditFilters({ ...blank(), actor: "lin" }),
    });
    expect(byForum.entries).toHaveLength(1);
    expect(byForum.entries[0]!.actor).toEqual({ kind: "forum", label: "Lin" });

    const bySystem = await loadAuditPage(db, {
      filters: auditFilters({ ...blank(), actor: "系统" }),
    });
    expect(bySystem.entries).toHaveLength(1);
    expect(bySystem.entries[0]!.actor.kind).toBe("system");
  });

  test("an unmatched filter returns an empty page with no cursor", async () => {
    await seed(3);

    const page = await loadAuditPage(db, {
      filters: auditFilters({ ...blank(), action: "nothing.like.this" }),
    });
    expect(page.entries).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  test("cursors and trails reject anything they cannot read", async () => {
    const cursor = { createdAt: new Date("2026-10-03T08:00:00.000Z"), id: crypto.randomUUID() };
    const encoded = encodeAuditCursor(cursor);
    const decoded = decodeAuditCursor(encoded);
    expect(decoded?.id).toBe(cursor.id);
    expect(decoded?.createdAt.toISOString()).toBe("2026-10-03T08:00:00.000Z");

    expect(decodeAuditCursor("not-a-cursor")).toBeNull();
    expect(decodeAuditCursor(Buffer.from('{"t":"2026-10-03","i":"x"}').toString("base64url"))).toBeNull();

    expect(parseAuditTrail(`${encoded},garbage`)).toEqual([encoded]);
    expect(parseAuditTrail(null)).toEqual([]);
  });
});

function blank() {
  return { actor: "", action: "", targetType: "", from: "", to: "" };
}

// `auditFilterValues` is what both the page and the route call; assert it trims and defaults.
test("filter values normalise empty strings to absent filters", () => {
  const params = new URLSearchParams({ actor: "  lin  ", action: "", targetType: "admin" });
  const values = auditFilterValues((name) => params.get(name));
  expect(values).toEqual({ actor: "lin", action: "", targetType: "admin", from: "", to: "" });

  const filters = auditFilters(values);
  expect(filters.actor).toBe("lin");
  expect(filters.action).toBeNull();
  expect(filters.from).toBeNull();
});
