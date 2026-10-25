import type { ProductKind, ProductStatus, ReleaseVersionState } from "@/lib/products/types";

/**
 * Presentation helpers for the review console. Pure functions only: they take values the
 * server component already read, so the console never invents a status, a capability or a
 * timestamp. "Waiting time" is humanised here, on the server, from the queue DTO.
 */

export function kindLabel(kind: ProductKind): string {
  return kind === "plugin" ? "插件" : "主题";
}

const PRODUCT_STATUS_LABELS: Record<ProductStatus, string> = {
  draft: "草稿",
  pending_review: "待审核",
  published: "已发布",
  rejected: "已拒绝",
  delisted: "已下架",
};

export function productStatusLabel(status: ProductStatus): string {
  return PRODUCT_STATUS_LABELS[status];
}

export type StatusTone = "success" | "warning" | "destructive" | "muted";

export function productStatusTone(status: ProductStatus): StatusTone {
  switch (status) {
    case "published":
      return "success";
    case "pending_review":
      return "warning";
    case "rejected":
      return "destructive";
    default:
      return "muted";
  }
}

const VERSION_STATE_LABELS: Record<ReleaseVersionState, string> = {
  candidate: "候选",
  pending_review: "待审核",
  published: "已发布",
  rejected: "已拒绝",
  yanked: "已撤回",
  needs_attention: "需注意",
};

export function versionStateLabel(state: ReleaseVersionState): string {
  return VERSION_STATE_LABELS[state];
}

export function versionStateTone(state: ReleaseVersionState): StatusTone {
  switch (state) {
    case "published":
      return "success";
    case "pending_review":
      return "warning";
    case "rejected":
      return "destructive";
    case "needs_attention":
      return "warning";
    default:
      return "muted";
  }
}

/** Event rows carry raw state keys; the console still has to print something readable. */
export function stateLabel(state: string | null): string | null {
  if (!state) return null;
  if (state in PRODUCT_STATUS_LABELS) {
    return PRODUCT_STATUS_LABELS[state as ProductStatus];
  }
  if (state in VERSION_STATE_LABELS) {
    return VERSION_STATE_LABELS[state as ReleaseVersionState];
  }
  return state;
}

const EVENT_ACTION_LABELS: Record<string, string> = {
  submitted: "提交审核",
  approved: "批准",
  rejected: "拒绝",
  published: "发布",
  auto_published: "自动发布",
  re_review_required: "重新送审",
  yanked: "撤回版本",
  delisted: "下架",
};

export function eventActionLabel(action: string): string {
  return EVENT_ACTION_LABELS[action] ?? action;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Relative time, e.g. "3 天前". Server-rendered only, so the printed value and the
 * `title` (exact ISO) always come from the same read.
 */
export function formatAgo(iso: string | null, now: number): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";

  const delta = now - at;
  if (delta < MINUTE) return "刚刚";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} 分钟前`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)} 小时前`;

  const days = Math.floor(delta / DAY);
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/** Waiting is the one age that reads better without the "ago" suffix in the queue. */
export function formatWaiting(iso: string | null, now: number): string {
  const ago = formatAgo(iso, now);
  if (ago === "—") return "—";
  if (ago === "刚刚") return "不到 1 分钟";
  return ago.replace(/前$/, "");
}

export type CapabilityDiff = {
  /** In this version, never approved. This is why a version is held. */
  added: string[];
  /** In both the snapshot and this version. */
  kept: string[];
  /** Approved before but not declared by this version. */
  removed: string[];
};

export function diffCapabilities(
  approved: string[],
  current: string[],
): CapabilityDiff {
  const approvedSet = new Set(approved);
  const currentSet = new Set(current);
  return {
    added: current.filter((key) => !approvedSet.has(key)),
    kept: current.filter((key) => approvedSet.has(key)),
    removed: approved.filter((key) => !currentSet.has(key)),
  };
}

/** GitHub is the only place a review link may point; `full_name` is display data. */
export function repoUrl(fullName: string | null): string | null {
  if (!fullName) return null;
  return `https://github.com/${fullName}`;
}
