import type { ProductStatus } from "@/lib/products/types";

/**
 * Auto-publish policy for new releases (plan §7.4 items 12–14).
 *
 * A product's first release is always human-reviewed; afterwards the sync worker may publish
 * on its own **only** while nothing about the product changed since the approval. "Changed"
 * means any of:
 *
 * - a capability key the moderator never saw (v1 is deliberately conservative: no risk
 *   levels, every new key re-opens review — see the S4 decision record);
 * - the product was renamed after approval (impersonation vector);
 * - the product was re-bound to another repository.
 */

export type ReleaseDecisionReason =
  | "product_not_published"
  | "snapshot_missing"
  | "renamed_since_review"
  | "repo_changed"
  | "unknown_capabilities"
  | "approved";

export type ReleaseDecision = {
  state: "published" | "pending_review";
  reason: ReleaseDecisionReason;
  /** Capability keys that are not in the approved snapshot (empty when approved). */
  unknownCapabilities: string[];
};

export type ReleaseDecisionInput = {
  productStatus: ProductStatus;
  productName: string;
  nameAtReview: string | null;
  repoId: number | null;
  repoIdReviewed: number | null;
  capabilitiesReviewed: string[];
  versionCapabilities: string[];
};

export function decideReleaseState(input: ReleaseDecisionInput): ReleaseDecision {
  const unknownCapabilities = input.versionCapabilities.filter(
    (capability) => !input.capabilitiesReviewed.includes(capability),
  );

  if (input.productStatus !== "published") {
    return {
      state: "pending_review",
      reason: "product_not_published",
      unknownCapabilities,
    };
  }

  // A published product with no snapshot predates the review flow (dev seed, manual SQL).
  // Auto-publishing on top of it would launder an unreviewed capability set.
  if (input.nameAtReview === null || input.repoIdReviewed === null) {
    return { state: "pending_review", reason: "snapshot_missing", unknownCapabilities };
  }

  if (input.productName !== input.nameAtReview) {
    return { state: "pending_review", reason: "renamed_since_review", unknownCapabilities };
  }

  if (input.repoId !== input.repoIdReviewed) {
    return { state: "pending_review", reason: "repo_changed", unknownCapabilities };
  }

  if (unknownCapabilities.length > 0) {
    return {
      state: "pending_review",
      reason: "unknown_capabilities",
      unknownCapabilities,
    };
  }

  return { state: "published", reason: "approved", unknownCapabilities: [] };
}
