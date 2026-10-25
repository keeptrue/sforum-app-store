/**
 * Moderation DTOs. Wire shapes of `/api/moderation/**`; the routes serialize them as-is.
 *
 * The queue has two kinds of work because the plan separates lifecycle from release state
 * (§5.3, Q3): a product waiting for its first approval, and a single version waiting because
 * it adds an unreviewed capability or the product was renamed after the last approval.
 */

import type { DashboardProduct, DashboardVersion } from "@/lib/products/types";

export type ModerationQueueProduct = {
  productId: string;
  slug: string;
  extensionId: string;
  name: string;
  kind: "plugin" | "theme";
  submittedAt: string;
  submittedBy: string | null;
  versionCount: number;
  latestVersion: string | null;
  capabilities: string[];
};

export type ModerationQueueVersion = {
  versionId: string;
  productId: string;
  slug: string;
  extensionId: string;
  productName: string;
  version: string;
  channel: "stable" | "beta";
  createdAt: string;
  sforumVersion: string;
  capabilities: string[];
  /** Capabilities that are not in the approved snapshot — the reason this version is held. */
  capabilitiesNew: string[];
  /** True when the product was renamed after the last approval. */
  productRenamed: boolean;
};

export type ModerationQueue = {
  products: ModerationQueueProduct[];
  versions: ModerationQueueVersion[];
};

export type ModerationEvent = {
  id: string;
  action: string;
  fromState: string | null;
  toState: string | null;
  reason: string | null;
  /** null = the system (sync worker) performed it. */
  actor: string | null;
  createdAt: string;
};

/**
 * The README as the review console shows it. `blobSha` and `fetchedAt` are the evidence that
 * the text can move after approval; the review itself covers the summary and the manifest.
 */
export type ModerationReadme = {
  path: string;
  html: string;
  blobSha: string | null;
  fetchedAt: string;
  byteSize: number | null;
  sourceUrl: string | null;
};

export type ModerationProductDetail = {
  product: DashboardProduct;
  summary: string;
  readme: ModerationReadme | null;
  versions: DashboardVersion[];
  repoFullName: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  publishedAt: string | null;
  nameAtReview: string | null;
  capabilitiesReviewed: string[];
  capabilitiesNew: string[];
  productRenamed: boolean;
  events: ModerationEvent[];
};
