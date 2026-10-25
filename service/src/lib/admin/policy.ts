import { desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Db } from "@/db/client";
import { moderationEvents, products, releaseVersions } from "@/db/schema";
import {
  decideReleaseState,
  type ReleaseDecisionInput,
  type ReleaseDecisionReason,
} from "@/lib/moderation/policy";

/**
 * Read-only view of the auto-publish policy (plan §7 "发布策略", §1 non-goal "策略可写").
 *
 * The rules are **not** restated here as prose that happens to be true today: each reason's
 * outcome is obtained by calling `decideReleaseState` itself with a probe input that isolates
 * that one branch. If the policy changes, the table follows; if a probe stops reproducing its
 * reason, `consistent` goes false and the page says so instead of describing dead rules.
 */

export type PolicyOutcome = "published" | "pending_review";

export type PolicyRule = {
  reason: ReleaseDecisionReason;
  outcome: PolicyOutcome;
  title: string;
  detail: string;
  /** False when `decideReleaseState` no longer answers this reason for the probe below. */
  consistent: boolean;
};

const APPROVED_PROBE: ReleaseDecisionInput = {
  productStatus: "published",
  productName: "example-plugin",
  nameAtReview: "example-plugin",
  repoId: 1,
  repoIdReviewed: 1,
  capabilitiesReviewed: ["content.read"],
  versionCapabilities: ["content.read"],
};

/**
 * One probe per reason, each changing exactly one field of the approved baseline so the
 * branch under test is the only branch that can fire.
 */
const PROBES: Record<ReleaseDecisionReason, ReleaseDecisionInput> = {
  approved: APPROVED_PROBE,
  product_not_published: { ...APPROVED_PROBE, productStatus: "pending_review" },
  snapshot_missing: { ...APPROVED_PROBE, nameAtReview: null },
  renamed_since_review: { ...APPROVED_PROBE, productName: "example-plugin-renamed" },
  repo_changed: { ...APPROVED_PROBE, repoId: 2 },
  unknown_capabilities: {
    ...APPROVED_PROBE,
    versionCapabilities: ["content.read", "admin.write"],
  },
};

/** Display order follows the order `decideReleaseState` checks its branches. */
const REASON_ORDER: ReleaseDecisionReason[] = [
  "approved",
  "product_not_published",
  "snapshot_missing",
  "renamed_since_review",
  "repo_changed",
  "unknown_capabilities",
];

type UncoveredReason = Exclude<ReleaseDecisionReason, (typeof REASON_ORDER)[number]>;
type AssertNever<T extends never> = T;
type _ReasonCoverage = AssertNever<UncoveredReason>;

const COPY: Record<ReleaseDecisionReason, { title: string; detail: string }> = {
  approved: {
    title: "一切未变，直接发布",
    detail:
      "产品已通过人工审核，且本次版本声明的能力是已审快照的子集；产品名与仓库绑定自审核以来没有变过。同步任务判定后直接发布，不再进审核队列。",
  },
  product_not_published: {
    title: "产品还没上线",
    detail:
      "产品本身不是「已发布」状态（草稿、待审、已驳回或已下架）。不论版本内容如何，新版本都先交给人工裁决。",
  },
  snapshot_missing: {
    title: "缺少审核快照",
    detail:
      "产品是「已发布」，但库里没有审核快照（审核时的名字或仓库 ID 为空）——通常是种子数据或手工 SQL 留下的历史行。在快照补上之前自动发布，等于让一套没审过的能力集合混过去。",
  },
  renamed_since_review: {
    title: "审核后改过名",
    detail:
      "产品显示名与审核时记录的名字不一致。改名是冒名顶替最常见的手法，所以必须有人再看一眼。",
  },
  repo_changed: {
    title: "换了仓库",
    detail:
      "产品绑定的 GitHub 仓库 ID 与审核时记录的不一致。换仓库等于换了发布来源，要重新审。",
  },
  unknown_capabilities: {
    title: "声明了没审过的能力",
    detail:
      "本次版本声明的能力键里有审核快照中没有的。v1 不分风险等级：任何新键都重开审核。判定结果会带上具体是哪几个键。",
  },
};

function buildRule(reason: ReleaseDecisionReason): PolicyRule {
  const decision = decideReleaseState(PROBES[reason]);
  return {
    reason,
    outcome: decision.state,
    title: COPY[reason].title,
    detail: COPY[reason].detail,
    consistent: decision.reason === reason,
  };
}

export const POLICY_RULES: PolicyRule[] = REASON_ORDER.map(buildRule);

/** Counts for the page header; derived from the rules so the two can never disagree. */
export const POLICY_SUMMARY = {
  autoPublish: POLICY_RULES.filter((rule) => rule.outcome === "published").length,
  heldForReview: POLICY_RULES.filter((rule) => rule.outcome === "pending_review").length,
  drifted: POLICY_RULES.filter((rule) => !rule.consistent).length,
};

/**
 * Action values that record a release decision, taken from the writers rather than from the
 * plan's sketch: `re_review_required` (held) and `auto_published` (policy let it through) are
 * written by `lib/github/sync.ts`; `approved` / `version.approved` by `lib/moderation/service.ts`
 * when a human publishes a product or a version. `published` and `re_pending_review` never
 * appear in `moderation_events`.
 */
const DECISION_ACTIONS = [
  "re_review_required",
  "auto_published",
  "approved",
  "version.approved",
] as const;

const OUTCOME_BY_ACTION: Record<(typeof DECISION_ACTIONS)[number], PolicyOutcome> = {
  re_review_required: "pending_review",
  auto_published: "published",
  approved: "published",
  "version.approved": "published",
};

export type RecentDecision = {
  id: string;
  action: string;
  outcome: PolicyOutcome;
  productName: string | null;
  version: string | null;
  /** Policy reason, present on policy-written rows only (human approvals carry none). */
  reason: string | null;
  createdAt: Date;
};

export const RECENT_DECISION_LIMIT = 20;

/** Human wording for a stored reason; unknown strings stay raw instead of disappearing. */
export function describeReason(reason: string | null): string | null {
  if (reason === null) return null;
  const known = POLICY_RULES.find((rule) => rule.reason === reason);
  return known ? known.title : reason;
}

export async function loadRecentDecisions(
  db: Db,
  limit = RECENT_DECISION_LIMIT,
): Promise<RecentDecision[]> {
  // A version row names its product through `release_versions.product_id`, so the join needs a
  // second reference to `products`; the alias keeps the two readable.
  const versionProduct = alias(products, "version_product");

  const rows = await db
    .select({
      id: moderationEvents.id,
      action: moderationEvents.action,
      reason: moderationEvents.reason,
      createdAt: moderationEvents.createdAt,
      productName: products.name,
      versionProductName: versionProduct.name,
      version: releaseVersions.version,
    })
    .from(moderationEvents)
    .leftJoin(products, eq(products.id, moderationEvents.productId))
    .leftJoin(releaseVersions, eq(releaseVersions.id, moderationEvents.releaseVersionId))
    .leftJoin(versionProduct, eq(versionProduct.id, releaseVersions.productId))
    .where(inArray(moderationEvents.action, [...DECISION_ACTIONS]))
    .orderBy(desc(moderationEvents.createdAt), desc(moderationEvents.id))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    outcome: OUTCOME_BY_ACTION[row.action as (typeof DECISION_ACTIONS)[number]],
    productName: row.productName ?? row.versionProductName,
    version: row.version,
    reason: row.reason,
    createdAt: row.createdAt,
  }));
}
