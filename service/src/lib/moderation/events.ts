import type { DbExecutor } from "@/lib/products/store";
import { auditLog, moderationEvents } from "@/db/schema";

/**
 * The two append-only trails. Callers pass the transaction they are already in, so a
 * state change and its evidence commit or roll back together (plan §7.4 item 19).
 */

export type ModerationEventInput = {
  productId?: string | null;
  releaseVersionId?: string | null;
  action: string;
  fromState?: string | null;
  toState?: string | null;
  actorAccountId?: string | null;
  reason?: string | null;
};

export type AuditInput = {
  actorAccountId?: string | null;
  /** Set when a store-local administrator acted; mutually exclusive with `actorAccountId`. */
  actorAdminId?: string | null;
  action: string;
  targetType:
    | "product"
    | "release_version"
    | "account"
    | "admin"
    | "issuer"
    | "github_app"
    | "store_settings"
    | "session";
  targetId?: string | null;
  details?: Record<string, unknown> | null;
  ip?: string | null;
};

export async function recordModerationEvent(
  tx: DbExecutor,
  input: ModerationEventInput,
): Promise<void> {
  const productId = input.productId ?? null;
  const releaseVersionId = input.releaseVersionId ?? null;
  if ((productId === null) === (releaseVersionId === null)) {
    // Exactly one subject. A row with both (or neither) would make the timeline ambiguous.
    throw new Error("moderation event needs exactly one subject");
  }

  await tx.insert(moderationEvents).values({
    productId,
    releaseVersionId,
    action: input.action,
    fromState: input.fromState ?? null,
    toState: input.toState ?? null,
    actorAccountId: input.actorAccountId ?? null,
    reason: input.reason ?? null,
  });
}

export async function recordAudit(tx: DbExecutor, input: AuditInput): Promise<void> {
  await tx.insert(auditLog).values({
    actorAccountId: input.actorAccountId ?? null,
    actorAdminId: input.actorAdminId ?? null,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    details: input.details ?? null,
    ip: input.ip ?? null,
  });
}
