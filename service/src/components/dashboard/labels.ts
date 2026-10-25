import type {
  DashboardVersion,
  ProductKind,
  ProductStatus,
  ReleaseVersionState,
} from "@/lib/products/types";

/**
 * Status vocabulary for the developer portal. Pure presentation: one place decides what a
 * state is called, which badge tone it gets and what the developer should do next, so the
 * list, the editor and the review panel cannot disagree.
 */

export type BadgeTone =
  | "default"
  | "secondary"
  | "outline"
  | "destructive"
  | "success"
  | "warning"
  | "muted";

export const STATUS_LABELS: Record<ProductStatus, string> = {
  draft: "草稿",
  pending_review: "待审核",
  published: "已发布",
  rejected: "已拒绝",
  delisted: "已下架",
};

export const STATUS_TONES: Record<ProductStatus, BadgeTone> = {
  draft: "muted",
  pending_review: "warning",
  published: "success",
  rejected: "destructive",
  delisted: "outline",
};

/**
 * What happens next in this state. This is guidance, not the moderator's reason: the review
 * verdict text is not part of the dashboard DTOs, so the panel must not pretend to quote it.
 */
export const STATUS_HINTS: Record<ProductStatus, string> = {
  draft: "还没有提交审核。补齐文案和至少一个可审版本后，点「提交审核」。",
  pending_review: "已进入人工审核队列。审核结论出来后状态会变化。",
  published: "已上线。之后的版本满足条件时自动发布，不用再提交。",
  rejected: "审核未通过。按审核意见修改文案后可以重新提交。",
  delisted: "已下架，目录与下载入口都不可见；重新提交并通过审核才能回到线上。",
};

export const KIND_LABELS: Record<ProductKind, string> = {
  plugin: "插件",
  theme: "主题",
};

export const KIND_OPTIONS: { value: ProductKind; label: string }[] = [
  { value: "plugin", label: "插件" },
  { value: "theme", label: "主题" },
];

export const VERSION_STATE_LABELS: Record<ReleaseVersionState, string> = {
  candidate: "待提交",
  pending_review: "待审核",
  published: "已发布",
  rejected: "已拒绝",
  yanked: "已撤回",
  needs_attention: "需注意",
};

export const VERSION_STATE_TONES: Record<ReleaseVersionState, BadgeTone> = {
  candidate: "muted",
  pending_review: "warning",
  published: "success",
  rejected: "destructive",
  yanked: "destructive",
  needs_attention: "warning",
};

export const CHANNEL_LABELS: Record<DashboardVersion["channel"], string> = {
  stable: "stable",
  beta: "beta",
};

/** How the repository binding was established. Never reads as "verified". */
export const REPO_BOUND_VIA_LABELS: Record<
  "installation" | "github_identity",
  string
> = {
  installation: "GitHub App 安装",
  github_identity: "GitHub 身份已验证",
};

/** Upstream connectivity of a bound repository (`github_repos.upstream_state`). */
export const UPSTREAM_STATE_LABELS: Record<
  "connected" | "degraded" | "disconnected",
  string
> = {
  connected: "上游正常",
  degraded: "上游异常",
  disconnected: "上游已断开",
};

export const UPSTREAM_STATE_TONES: Record<
  "connected" | "degraded" | "disconnected",
  BadgeTone
> = {
  connected: "success",
  degraded: "warning",
  disconnected: "destructive",
};

/** The two states a moderator can actually review; submit is blocked without one. */
export function isReviewable(version: DashboardVersion): boolean {
  return version.state === "candidate" || version.state === "pending_review";
}

/** Submitting is only legal from these two states (the API answers 409 otherwise). */
export function canSubmit(status: ProductStatus): boolean {
  return status === "draft" || status === "rejected";
}

const dateTimeFormat = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Absolute timestamp; the raw ISO string goes in `title` so no timezone is implied twice. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : dateTimeFormat.format(date);
}

/** YYYY-MM-DD straight from the ISO string: stable across server and client renders. */
export function formatDay(iso: string | null | undefined): string {
  return iso && iso.length >= 10 ? iso.slice(0, 10) : "—";
}

export function platformLabel(platform: { os: string; arch: string }): string {
  return `${platform.os}/${platform.arch}`;
}

/**
 * Brand assets: where the picture came from, and the vocabulary for the two ways it can be
 * wrong. A `note` means the brand file was skipped but a fallback mark is on screen; an
 * `error` means the refresh failed and the previous picture is still there.
 */
export const BRAND_SOURCE_LABELS: Record<"brand_icon" | "social_preview", string> = {
  brand_icon: "brand/icon.png",
  social_preview: "GitHub 社交预览",
};

/** The icon slot refused the file it found; a fallback mark is on screen. */
const BRAND_NOTE_TEXT: Record<string, string> = {
  brand_not_png: "品牌图标不是 PNG，这次用的是社交预览图。",
  brand_not_square: "品牌图标不是正方形，这次用的是社交预览图。",
  brand_too_large: "品牌图标超过 1 MiB，这次用的是社交预览图。",
  brand_invalid_image: "品牌图标读不出尺寸，这次用的是社交预览图。",
  brand_not_a_file: "品牌图标不是普通文件（目录、子模块或符号链接）。",
  brand_read_failed: "读品牌图标时 GitHub 报错，这次用的是社交预览图。",
  brand_layout_ambiguous:
    "仓库里有多个扩展包目录，无法判断品牌图属于哪个；把扩展包放在仓库根，或让清单 id 与产品一致。",
};

/** Anything that ended with "no new picture". */
const BRAND_ERROR_TEXT: Record<string, string> = {
  no_repo: "产品还没有绑定仓库，先绑定仓库再来刷新。",
  github_not_configured: "这个部署没有配置 GitHub App，读不到仓库里的文件。",
  social_file_missing: "仓库里没有 brand/social-preview.png，当前分享图还是上一次抓到的。",
  social_file_too_large: "分享卡文件超过 1 MiB。",
  social_file_not_a_file: "分享卡不是普通文件。",
  social_file_github_unknown: "读分享卡时 GitHub 报错。",
  social_not_png: "brand/social-preview.png 不是 PNG。",
  social_bad_ratio: "brand/social-preview.png 不是 2:1（例如 1280×640）。",
  social_too_large: "brand/social-preview.png 超过 1 MiB。",
  social_invalid_image: "brand/social-preview.png 读不出尺寸。",
};

/**
 * One code → one sentence. `social_preview_*` comes from the fallback fetcher, which speaks
 * GitHub's own vocabulary (network, http_error, no_og_image, ghes, …); those tails are
 * printed as-is rather than duplicated here.
 */
export function describeBrandCode(code: string | null): string | null {
  if (!code) return null;
  const known = BRAND_NOTE_TEXT[code] ?? BRAND_ERROR_TEXT[code];
  if (known) return known;
  if (code.startsWith("social_preview_")) {
    return `社交预览图抓取失败（${code.slice("social_preview_".length)}），当前图还是上一次抓到的。`;
  }
  if (code.startsWith("social_file_github_")) {
    return `读分享卡时 GitHub 报错（HTTP ${code.slice("social_file_github_".length)}）。`;
  }
  if (code.startsWith("brand_")) {
    return `brand 文件不可用（${code.slice("brand_".length)}），当前图还是上一次抓到的。`;
  }
  return code;
}
