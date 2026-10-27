import { and, eq, isNull, lt, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import {
  accountTokens,
  accounts,
  installAuthRequests,
} from "@/db/schema";

/**
 * SQL for the install gate. No policy lives here: the state machine and the gates are in
 * `service.ts`, and the routes only decode/encode. Every mutation is a conditional UPDATE so a
 * concurrent approve/exchange cannot win twice.
 */

export type AuthRequestRow = typeof installAuthRequests.$inferSelect;
export type AccountTokenRow = typeof accountTokens.$inferSelect;

export async function insertAuthRequest(
  db: Db,
  input: {
    codeChallenge: string;
    clientLabel: string | null;
    expiresAt: Date;
    intervalSeconds: number;
    createdIp: string | null;
    userAgent: string | null;
  },
): Promise<AuthRequestRow> {
  const [row] = await db
    .insert(installAuthRequests)
    .values({
      codeChallenge: input.codeChallenge,
      clientLabel: input.clientLabel,
      expiresAt: input.expiresAt,
      intervalSeconds: input.intervalSeconds,
      createdIp: input.createdIp,
      userAgent: input.userAgent,
    })
    .returning();
  return row;
}

export async function findAuthRequest(
  db: Db,
  id: string,
): Promise<AuthRequestRow | null> {
  const [row] = await db
    .select()
    .from(installAuthRequests)
    .where(eq(installAuthRequests.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Flip a stale `pending`/`approved` row to `expired`.
 *
 * Conditional on the row still being un-expired at the database, so two concurrent readers
 * cannot both claim the transition, and a request approved one millisecond before the sweep
 * is not retroactively killed.
 */
export async function expireAuthRequest(
  db: Db,
  id: string,
  now: Date,
): Promise<boolean> {
  const updated = await db
    .update(installAuthRequests)
    .set({ status: "expired" })
    .where(
      and(
        eq(installAuthRequests.id, id),
        sql`${installAuthRequests.status} in ('pending','approved')`,
        lt(installAuthRequests.expiresAt, now),
      ),
    )
    .returning({ id: installAuthRequests.id });
  return updated.length > 0;
}

/** `pending → approved`, once. Returns false when someone else already decided. */
export async function approveAuthRequest(
  db: Db,
  id: string,
  accountId: string,
  now: Date,
): Promise<boolean> {
  const updated = await db
    .update(installAuthRequests)
    .set({ status: "approved", accountId, approvedAt: now })
    .where(
      and(
        eq(installAuthRequests.id, id),
        eq(installAuthRequests.status, "pending"),
        sql`${installAuthRequests.expiresAt} > ${now}`,
      ),
    )
    .returning({ id: installAuthRequests.id });
  return updated.length > 0;
}

/** `pending → denied`, once. */
export async function denyAuthRequest(
  db: Db,
  id: string,
  now: Date,
): Promise<boolean> {
  const updated = await db
    .update(installAuthRequests)
    .set({ status: "denied", approvedAt: now })
    .where(
      and(
        eq(installAuthRequests.id, id),
        eq(installAuthRequests.status, "pending"),
      ),
    )
    .returning({ id: installAuthRequests.id });
  return updated.length > 0;
}

/**
 * Consume an approved request and mint the token row in one transaction.
 *
 * The consume is the lock: it only matches `status = 'approved'` and an unexpired row, so a
 * replayed exchange (or two parallel ones) gets `null` and never a second token.
 */
export async function consumeRequestAndInsertToken(
  db: Db,
  input: {
    requestId: string;
    accountId: string;
    tokenHash: string;
    scope: string;
    expiresAt: Date;
    clientLabel: string | null;
    createdIp: string | null;
    userAgent: string | null;
    now: Date;
  },
): Promise<AccountTokenRow | null> {
  return db.transaction(async (tx) => {
    const consumed = await tx
      .update(installAuthRequests)
      .set({ status: "consumed", consumedAt: input.now })
      .where(
        and(
          eq(installAuthRequests.id, input.requestId),
          eq(installAuthRequests.status, "approved"),
          sql`${installAuthRequests.expiresAt} > ${input.now}`,
        ),
      )
      .returning({ id: installAuthRequests.id });
    if (consumed.length === 0) return null;

    const [token] = await tx
      .insert(accountTokens)
      .values({
        accountId: input.accountId,
        tokenHash: input.tokenHash,
        scope: input.scope,
        expiresAt: input.expiresAt,
        clientLabel: input.clientLabel,
        createdIp: input.createdIp,
        userAgent: input.userAgent,
      })
      .returning();
    return token ?? null;
  });
}

/** One row by hash, joined with the account it belongs to. */
export async function findAccountTokenByHash(
  db: Db,
  tokenHash: string,
): Promise<{ token: AccountTokenRow; account: typeof accounts.$inferSelect } | null> {
  const [row] = await db
    .select({ token: accountTokens, account: accounts })
    .from(accountTokens)
    .innerJoin(accounts, eq(accountTokens.accountId, accounts.id))
    .where(eq(accountTokens.tokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

/**
 * Throttled `last_used_at`: only writes when the previous value is older than the interval, so
 * a forum installing often does not turn every download-url call into a row update.
 */
export async function touchAccountToken(
  db: Db,
  id: string,
  now: Date,
  intervalSeconds: number,
): Promise<void> {
  const cutoff = new Date(now.getTime() - intervalSeconds * 1000);
  await db
    .update(accountTokens)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(accountTokens.id, id),
        sql`(${accountTokens.lastUsedAt} is null or ${accountTokens.lastUsedAt} < ${cutoff})`,
      ),
    );
}

/** Idempotent: revoking an already-revoked token leaves the original timestamp alone. */
export async function revokeAccountToken(
  db: Db,
  id: string,
  now: Date,
): Promise<void> {
  await db
    .update(accountTokens)
    .set({ revokedAt: now })
    .where(and(eq(accountTokens.id, id), isNull(accountTokens.revokedAt)));
}

/** The account behind a request, for the exchange response. */
export async function findAccountById(
  db: Db,
  accountId: string,
): Promise<typeof accounts.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return row ?? null;
}
