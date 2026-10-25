import type { Db } from "@/db/client";
import { readSessionCookie } from "@/lib/auth/cookies";
import { isSameOrigin, jsonError } from "@/lib/auth/http";
import { findSession, getRoles } from "@/lib/auth/service";
import { getRuntimeConfig } from "@/lib/settings/runtime";
import { recordAudit, recordModerationEvent } from "@/lib/moderation/events";
import { ProductError } from "@/lib/products/service";
import { recomputeProductLatestVersions } from "@/lib/products/latest";
import { findVersionWithProduct } from "@/lib/products/store";
import type { DashboardProduct } from "@/lib/products/types";
import { loadDashboardProduct, loadDisplayName } from "./queue";
import {
  delistPublishedProduct,
  findProductRow,
  publishPendingProduct,
  publishPendingVersion,
  publishReviewableVersions,
  rejectPendingProduct,
  rejectPendingVersion,
  setReviewSnapshot,
} from "./store";

/**
 * Moderation decisions (plan §7.4 items 8–11, 16, 19).
 *
 * A decision is one transaction that moves the state, moves/fixes whatever the state
 * implies (versions, review snapshot) and appends the two evidence rows. The event writer
 * runs last and inside the same transaction on purpose: if either trail cannot be written,
 * the state change must not survive (item 19). Everything after the commit — recomputing
 * the materialized latest versions — is derived data and can be recomputed again.
 */

const MAX_REASON_LENGTH = 500;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODERATOR_ROLES = new Set(["moderator"]);

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** 1..500 characters after trimming; anything else is a client error, not a state error. */
function normalizeReason(raw: unknown): string {
  if (typeof raw !== "string") throw new ProductError("invalid_reason", 400);
  const reason = raw.trim();
  if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
    throw new ProductError("invalid_reason", 400);
  }
  return reason;
}

/** Existing snapshot first, then whatever the newly approved versions add. */
function unionCapabilities(existing: string[], additions: string[][]): string[] {
  const seen = new Set(existing);
  const merged = [...existing];
  for (const list of additions) {
    for (const capability of list) {
      if (seen.has(capability)) continue;
      seen.add(capability);
      merged.push(capability);
    }
  }
  return merged;
}

async function requireDashboardProduct(
  db: Db,
  productId: string,
): Promise<DashboardProduct> {
  const product = await loadDashboardProduct(db, productId);
  if (!product) throw new ProductError("product_not_found", 404);
  return product;
}

// ---------------------------------------------------------------------------
// Role gate
// ---------------------------------------------------------------------------

export type ModerationAuth =
  | { ok: true; accountId: string }
  | { ok: false; response: Response };

/**
 * `admin|moderator` from `store_roles`, never from a forum group (AGENTS.md boundary 7).
 *
 * The order is fixed and load-bearing: a cross-origin mutation is rejected before the
 * session is read (CSRF is a transport concern, not an identity one), and an anonymous
 * caller learns nothing about the resource — 401 before any lookup, 403 once authenticated
 * without the role.
 */
export async function authorizeModerationRequest(
  db: Db,
  request: Request,
  options: { mutation: boolean },
): Promise<ModerationAuth> {
  const { publicUrl } = await getRuntimeConfig(db);
  if (options.mutation && !isSameOrigin(request, publicUrl)) {
    return { ok: false, response: jsonError("cross_origin", 403) };
  }

  const token = await readSessionCookie();
  const session = token ? await findSession(db, token) : null;
  if (!session) {
    return { ok: false, response: jsonError("unauthenticated", 401) };
  }

  const roles = await getRoles(db, session.account.id);
  if (!roles.some((role) => MODERATOR_ROLES.has(role))) {
    return { ok: false, response: jsonError("forbidden", 403) };
  }

  return { ok: true, accountId: session.account.id };
}

// ---------------------------------------------------------------------------
// Product decisions
// ---------------------------------------------------------------------------

/**
 * `pending_review -> published`, plus every `candidate|pending_review` version.
 *
 * The snapshot refresh is what lets the sync worker publish the *next* release without a
 * human: it records the name, the repository binding and the union of capability keys a
 * moderator has now seen (plan §7.4 items 8, 12).
 */
export async function approveProduct(
  db: Db,
  input: { accountId: string; productId: string; ip?: string | null },
): Promise<DashboardProduct> {
  if (!isUuid(input.productId)) {
    throw new ProductError("product_not_found", 404);
  }
  const now = new Date();

  await db.transaction(async (tx) => {
    const product = await findProductRow(tx, input.productId);
    if (!product) throw new ProductError("product_not_found", 404);

    const published = await publishPendingProduct(tx, product.id, now);
    if (!published) throw new ProductError("invalid_state", 409);

    const versions = await publishReviewableVersions(tx, product.id, now);
    const nameAtReview = await loadDisplayName(tx, product);
    const capabilitiesReviewed = unionCapabilities(
      product.capabilitiesReviewed,
      versions.map((version) => version.capabilities),
    );

    await setReviewSnapshot(
      tx,
      product.id,
      { nameAtReview, repoIdReviewed: product.repoId, capabilitiesReviewed },
      now,
    );

    await recordModerationEvent(tx, {
      productId: product.id,
      action: "approved",
      fromState: "pending_review",
      toState: "published",
      actorAccountId: input.accountId,
    });
    await recordAudit(tx, {
      actorAccountId: input.accountId,
      action: "product.approved",
      targetType: "product",
      targetId: product.id,
      details: {
        versions: versions.map((version) => version.version),
        capabilitiesReviewed,
        publishedAt: published.publishedAt?.toISOString() ?? null,
      },
      ip: input.ip ?? null,
    });
  });

  await recomputeProductLatestVersions(db, input.productId);
  return requireDashboardProduct(db, input.productId);
}

/** `pending_review -> rejected`. Versions stay where they are so they can be resubmitted. */
export async function rejectProduct(
  db: Db,
  input: {
    accountId: string;
    productId: string;
    reason: unknown;
    ip?: string | null;
  },
): Promise<DashboardProduct> {
  if (!isUuid(input.productId)) {
    throw new ProductError("product_not_found", 404);
  }
  const reason = normalizeReason(input.reason);
  const now = new Date();

  await db.transaction(async (tx) => {
    const product = await findProductRow(tx, input.productId);
    if (!product) throw new ProductError("product_not_found", 404);

    const rejected = await rejectPendingProduct(tx, product.id, now);
    if (!rejected) throw new ProductError("invalid_state", 409);

    await recordModerationEvent(tx, {
      productId: product.id,
      action: "rejected",
      fromState: "pending_review",
      toState: "rejected",
      actorAccountId: input.accountId,
      reason,
    });
    await recordAudit(tx, {
      actorAccountId: input.accountId,
      action: "product.rejected",
      targetType: "product",
      targetId: product.id,
      details: { reason },
      ip: input.ip ?? null,
    });
  });

  return requireDashboardProduct(db, input.productId);
}

/**
 * `published -> delisted`. Delisting is a visibility decision only: versions keep their
 * state and their bytes, and the product comes back through submission + review
 * (plan §7.4 item 16).
 */
export async function delistProductAsModerator(
  db: Db,
  input: {
    /** Forum account taking the action. Omitted when a store-local admin does. */
    accountId?: string | null;
    actorAdminId?: string | null;
    productId: string;
    reason: unknown;
    ip?: string | null;
  },
): Promise<DashboardProduct> {
  if (!isUuid(input.productId)) {
    throw new ProductError("product_not_found", 404);
  }
  const reason = normalizeReason(input.reason);
  const now = new Date();

  await db.transaction(async (tx) => {
    const product = await findProductRow(tx, input.productId);
    if (!product) throw new ProductError("product_not_found", 404);

    const delisted = await delistPublishedProduct(tx, product.id, now);
    if (!delisted) throw new ProductError("invalid_state", 409);

    await recordModerationEvent(tx, {
      productId: product.id,
      action: "delisted",
      fromState: "published",
      toState: "delisted",
      actorAccountId: input.accountId ?? null,
      reason,
    });
    await recordAudit(tx, {
      actorAccountId: input.accountId ?? null,
      actorAdminId: input.actorAdminId ?? null,
      action: "product.delisted",
      targetType: "product",
      targetId: product.id,
      details: { reason, via: input.actorAdminId ? "admin" : "moderation" },
      ip: input.ip ?? null,
    });
  });

  return requireDashboardProduct(db, input.productId);
}

// ---------------------------------------------------------------------------
// Version decisions (the re-review bucket)
// ---------------------------------------------------------------------------

/**
 * Publish one held version. Only the state moves: content, digest and capability list
 * were frozen when the release synced (item 14), so there is nothing here that could
 * change what users download for an already published version.
 *
 * Refreshing the snapshot after approval is what clears the re-review trigger: the
 * capability keys of this version become reviewed ones.
 */
export async function approveVersion(
  db: Db,
  input: { accountId: string; versionId: string; ip?: string | null },
): Promise<DashboardProduct> {
  if (!isUuid(input.versionId)) {
    throw new ProductError("version_not_found", 404);
  }
  const now = new Date();

  const productId = await db.transaction(async (tx) => {
    const found = await findVersionWithProduct(tx, input.versionId);
    if (!found) throw new ProductError("version_not_found", 404);
    // A version cannot be published under a product that is not live; that would make a
    // "published" release unreachable and hide the product decision that is actually due.
    if (found.product.status !== "published") {
      throw new ProductError("product_not_published", 409);
    }

    const published = await publishPendingVersion(tx, found.version.id, now);
    if (!published) throw new ProductError("invalid_state", 409);

    const nameAtReview = await loadDisplayName(tx, found.product);
    const capabilitiesReviewed = unionCapabilities(found.product.capabilitiesReviewed, [
      published.capabilities,
    ]);
    await setReviewSnapshot(
      tx,
      found.product.id,
      { nameAtReview, repoIdReviewed: found.product.repoId, capabilitiesReviewed },
      now,
    );

    await recordModerationEvent(tx, {
      releaseVersionId: found.version.id,
      action: "version.approved",
      fromState: "pending_review",
      toState: "published",
      actorAccountId: input.accountId,
    });
    await recordAudit(tx, {
      actorAccountId: input.accountId,
      action: "release_version.approved",
      targetType: "release_version",
      targetId: found.version.id,
      details: {
        productId: found.product.id,
        version: found.version.version,
        capabilitiesReviewed,
      },
      ip: input.ip ?? null,
    });

    return found.product.id;
  });

  await recomputeProductLatestVersions(db, productId);
  return requireDashboardProduct(db, productId);
}

/** `pending_review -> rejected` for one version; it disappears from the public surface. */
export async function rejectVersion(
  db: Db,
  input: {
    accountId: string;
    versionId: string;
    reason: unknown;
    ip?: string | null;
  },
): Promise<DashboardProduct> {
  if (!isUuid(input.versionId)) {
    throw new ProductError("version_not_found", 404);
  }
  const reason = normalizeReason(input.reason);
  const now = new Date();

  const productId = await db.transaction(async (tx) => {
    const found = await findVersionWithProduct(tx, input.versionId);
    if (!found) throw new ProductError("version_not_found", 404);

    const rejected = await rejectPendingVersion(tx, found.version.id, now);
    if (!rejected) throw new ProductError("invalid_state", 409);

    await recordModerationEvent(tx, {
      releaseVersionId: found.version.id,
      action: "version.rejected",
      fromState: "pending_review",
      toState: "rejected",
      actorAccountId: input.accountId,
      reason,
    });
    await recordAudit(tx, {
      actorAccountId: input.accountId,
      action: "release_version.rejected",
      targetType: "release_version",
      targetId: found.version.id,
      details: { productId: found.product.id, version: found.version.version, reason },
      ip: input.ip ?? null,
    });

    return found.product.id;
  });

  return requireDashboardProduct(db, productId);
}
