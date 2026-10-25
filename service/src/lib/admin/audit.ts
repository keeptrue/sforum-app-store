import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";

import type { Db } from "@/db/client";
import { accounts, adminAccounts, auditLog } from "@/db/schema";
import type { AuditInput } from "@/lib/moderation/events";

/**
 * Read model for the audit trail (plan §7 "审计日志").
 *
 * The table is append-only and written on nearly every admin action, so paging is keyset on
 * `(created_at desc, id desc)`. An offset would slide by however many rows landed between two
 * page fetches — on this table that is the normal case, not the edge case.
 */

export const AUDIT_PAGE_SIZE = 50;

export type AuditTargetType = AuditInput["targetType"];

/**
 * Filter options for the console. Kept next to `AuditInput["targetType"]` on purpose: the
 * compile-time guard below turns "someone added a target type" into a type error instead of a
 * filter that silently cannot select the new rows.
 */
export const AUDIT_TARGET_TYPES = [
  "admin",
  "account",
  "github_app",
  "issuer",
  "product",
  "release_version",
  "session",
  "store_settings",
] as const satisfies readonly AuditTargetType[];

type UncoveredTargetType = Exclude<AuditTargetType, (typeof AUDIT_TARGET_TYPES)[number]>;
type AssertNever<T extends never> = T;
type _TargetTypeCoverage = AssertNever<UncoveredTargetType>;

/** `YYYY-MM-DD HH:mm:ss` in UTC — the same clock the `from` / `to` filters read. */
export function formatTimestampUtc(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

export type AuditFilters = {
  actor: string | null;
  action: string | null;
  targetType: string | null;
  /** Inclusive lower bound, UTC midnight of the selected day. */
  from: Date | null;
  /** Exclusive upper bound: the day *after* the selected `to`, so a date input stays inclusive. */
  toExclusive: Date | null;
};

/** What the filter form shows back to the operator: raw text, not the parsed bounds. */
export type AuditFilterValues = {
  actor: string;
  action: string;
  targetType: string;
  from: string;
  to: string;
};

const DAY_MS = 86_400_000;
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function utcDayStart(raw: string | null): Date | null {
  if (raw === null || !DAY_ONLY.test(raw)) return null;
  const time = Date.parse(`${raw}T00:00:00.000Z`);
  return Number.isNaN(time) ? null : new Date(time);
}

/**
 * One reader for both callers: the page passes its `searchParams` getter, the route passes
 * `URLSearchParams.get`. Sharing it keeps the HTML and the JSON surface answering the same
 * question the same way.
 */
export function auditFilterValues(get: (name: string) => string | null): AuditFilterValues {
  return {
    actor: (get("actor") ?? "").trim(),
    action: (get("action") ?? "").trim(),
    targetType: (get("targetType") ?? "").trim(),
    from: (get("from") ?? "").trim(),
    to: (get("to") ?? "").trim(),
  };
}

/**
 * Bad dates and unparseable bounds are dropped instead of rejected: a filter is a UI
 * affordance, and a hand-edited URL must not turn the whole console page into an error.
 */
export function auditFilters(values: AuditFilterValues): AuditFilters {
  const from = utcDayStart(values.from === "" ? null : values.from);
  const to = utcDayStart(values.to === "" ? null : values.to);
  return {
    actor: values.actor === "" ? null : values.actor,
    action: values.action === "" ? null : values.action,
    targetType: values.targetType === "" ? null : values.targetType,
    from,
    toExclusive: to === null ? null : new Date(to.getTime() + DAY_MS),
  };
}

export function hasAuditFilters(filters: AuditFilters): boolean {
  return (
    filters.actor !== null ||
    filters.action !== null ||
    filters.targetType !== null ||
    filters.from !== null ||
    filters.toExclusive !== null
  );
}

export type AuditCursor = { createdAt: Date; id: string };

const CURSOR_SHAPE = /^[A-Za-z0-9_-]+={0,2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Unsigned and unpadded: the token only carries a boundary, so a tampered one can at worst
 * start the page somewhere else. The id must still look like a uuid — it is cast back to
 * `uuid` in SQL, and a malformed value would surface as a database error instead of a 400.
 */
export function encodeAuditCursor(cursor: AuditCursor): string {
  const payload = JSON.stringify({ t: cursor.createdAt.toISOString(), i: cursor.id });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeAuditCursor(raw: string): AuditCursor | null {
  if (!CURSOR_SHAPE.test(raw)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const time = record.t;
  const id = record.i;
  if (typeof time !== "string" || !ISO_INSTANT.test(time)) return null;
  if (typeof id !== "string" || !UUID.test(id)) return null;

  const parsedTime = Date.parse(time);
  if (Number.isNaN(parsedTime)) return null;

  return { createdAt: new Date(parsedTime), id };
}

/**
 * The HTML page walks both directions, and a single keyset cursor has no "previous page".
 * So the page carries the whole stack of cursors it walked (`?trail=c1,c2,c3`); the JSON API
 * stays stateless with one `cursor`, which is what a machine caller wants.
 */
export function parseAuditTrail(raw: string | null): string[] {
  if (!raw) return [];
  const trail: string[] = [];
  for (const part of raw.split(",")) {
    if (decodeAuditCursor(part) === null) break;
    trail.push(part);
  }
  return trail;
}

export type AuditActor = {
  kind: "admin" | "forum" | "system";
  label: string;
};

export type AuditEntry = {
  id: string;
  createdAt: Date;
  actor: AuditActor;
  action: string;
  targetType: string;
  targetId: string | null;
  ip: string | null;
  details: Record<string, unknown> | null;
};

export type AuditPageResult = {
  entries: AuditEntry[];
  nextCursor: string | null;
};

const LIKE_ESCAPE = /[\\%_]/g;
const SYSTEM_LABELS = new Set(["系统", "system"]);

/** Substring match, with LIKE metacharacters escaped so `%` in a search stays a literal. */
function contains(value: string): string {
  return `%${value.replace(LIKE_ESCAPE, (char) => `\\${char}`)}%`;
}

function actorOf(row: {
  adminUsername: string | null;
  adminDisplayName: string | null;
  accountUsername: string | null;
  accountDisplayName: string | null;
}): AuditActor {
  if (row.adminUsername !== null) {
    return {
      kind: "admin",
      label: row.adminDisplayName?.trim() || row.adminUsername,
    };
  }
  if (row.accountUsername !== null || row.accountDisplayName !== null) {
    return {
      kind: "forum",
      label: row.accountDisplayName?.trim() || row.accountUsername || "论坛账号",
    };
  }
  return { kind: "system", label: "系统" };
}

export async function loadAuditPage(
  db: Db,
  options: {
    filters: AuditFilters;
    cursor?: AuditCursor | null;
    limit?: number;
  },
): Promise<AuditPageResult> {
  const limit = options.limit ?? AUDIT_PAGE_SIZE;
  const { filters, cursor } = options;
  const conditions: SQL[] = [];

  if (filters.actor !== null) {
    // The console renders actorless rows as 「系统」, so typing that word has to find them;
    // otherwise the one label the UI invents would be the one thing it cannot search.
    if (SYSTEM_LABELS.has(filters.actor.toLowerCase())) {
      conditions.push(
        sql`${auditLog.actorAdminId} is null and ${auditLog.actorAccountId} is null`,
      );
    } else {
      const pattern = contains(filters.actor);
      const match = or(
        ilike(adminAccounts.username, pattern),
        ilike(accounts.username, pattern),
        ilike(accounts.displayName, pattern),
      );
      if (match) conditions.push(match);
    }
  }
  if (filters.action !== null) {
    conditions.push(ilike(auditLog.action, contains(filters.action)));
  }
  if (filters.targetType !== null) {
    conditions.push(eq(auditLog.targetType, filters.targetType));
  }
  if (filters.from !== null) {
    conditions.push(sql`${auditLog.createdAt} >= ${filters.from}`);
  }
  if (filters.toExclusive !== null) {
    conditions.push(sql`${auditLog.createdAt} < ${filters.toExclusive}`);
  }
  if (cursor) {
    // Row-value comparison, so a page boundary that shares a timestamp with the previous
    // page still advances by id instead of repeating or skipping rows.
    conditions.push(
      sql`(${auditLog.createdAt}, ${auditLog.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
    );
  }

  const rows = await db
    .select({
      id: auditLog.id,
      createdAt: auditLog.createdAt,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      ip: auditLog.ip,
      details: auditLog.details,
      adminUsername: adminAccounts.username,
      adminDisplayName: adminAccounts.displayName,
      accountUsername: accounts.username,
      accountDisplayName: accounts.displayName,
    })
    .from(auditLog)
    .leftJoin(adminAccounts, eq(adminAccounts.id, auditLog.actorAdminId))
    .leftJoin(accounts, eq(accounts.id, auditLog.actorAccountId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  return {
    entries: page.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      actor: actorOf(row),
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      ip: row.ip,
      details: row.details ?? null,
    })),
    nextCursor:
      rows.length > limit && last
        ? encodeAuditCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}
