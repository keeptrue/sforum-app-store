import type { Compatibility } from "@/lib/catalog/query";

/**
 * Catalog filter vocabulary and presentation helpers.
 *
 * Platform rows are a *filter menu*, not a data claim: they carry no counts, because only
 * the server query knows how many products a platform has.
 */
export const PLATFORMS = [
  "linux/amd64",
  "linux/arm64",
  "darwin/arm64",
  "darwin/amd64",
  "windows/amd64",
  "any/any",
] as const;

export const KIND_TABS = [
  ["all", "全部"],
  ["plugin", "插件"],
  ["theme", "主题"],
] as const;

export type KindTab = (typeof KIND_TABS)[number][0];

type CompatibilityBadge = {
  label: string;
  variant: "success" | "destructive" | "warning";
  hint?: string;
};

/**
 * A badge is a claim about a *host*, so only a real verdict earns one.
 *
 * `unknown` means nobody told the store which core this page is for — a fact about the
 * request, not about the product. It used to be rendered as a grey 「未校验」 on every
 * card, which is constant (no signal), and reads like a trust verdict on the product in a
 * slot that belongs to the product. The page states it once, via `describeCompatibility`.
 */
export function badgeForCompatibility(
  compatibility: Compatibility,
): CompatibilityBadge | null {
  if (compatibility.estimated) {
    return { label: "按开发版估算", variant: "warning" };
  }
  switch (compatibility.status) {
    case "compatible":
      return {
        label: "兼容",
        variant: "success",
        hint: compatibility.constraint
          ? `命中约束 ${compatibility.constraint}`
          : undefined,
      };
    case "incompatible":
      return {
        label: "不兼容",
        variant: "destructive",
        hint: compatibility.constraint
          ? `宿主不满足 ${compatibility.constraint}`
          : undefined,
      };
    default:
      return null;
  }
}

/**
 * The word a surface uses when it has no verdict to give. Kept as one constant so the
 * catalog card, the detail table and the plugin copy cannot drift into three phrasings.
 */
export const UNJUDGED_LABEL = "未判定";

/**
 * Toolbar sentence describing what the server actually did with the host version.
 *
 * Page-level status is `unknown` or `compatible` only (`pageCompatibility` in
 * `lib/catalog/query.ts`); a per-product `incompatible` never reaches this function, so
 * there is deliberately no branch for it here.
 */
export function describeCompatibility(
  compatibility: Compatibility,
  compatParam: string | undefined,
): string {
  if (compatibility.estimated) {
    return "宿主版本为开发版，兼容性按开发版估算";
  }
  if (compatibility.status === "unknown") {
    return "未提供论坛版本 · 本页只展示各版本的 sforumVersion 约束，兼容性由 core 在安装时判定";
  }
  return compatParam === "all"
    ? "已按宿主 sforumVersion 校验，未按兼容性过滤"
    : "已按宿主 sforumVersion 过滤";
}

const CONSTRAINT_CHIP_MAX = 18;

/**
 * The manifest constraint as a chip: the raw text, truncated only for layout, with the
 * full value in `title`. Operators are never rewritten — the detail page prints the same
 * string, and two representations of one constraint would drift apart.
 */
export function constraintChip(
  constraint: string | null | undefined,
): { text: string; title: string } | null {
  const value = (constraint ?? "").trim();
  if (!value) return null;
  const text =
    value.length > CONSTRAINT_CHIP_MAX
      ? `${value.slice(0, CONSTRAINT_CHIP_MAX - 1)}…`
      : value;
  return { text, title: value };
}

/** MM-DD. Slicing the ISO string keeps SSR and the hydrated client in agreement. */
export function formatMonthDay(value: string | Date | null | undefined): string {
  const iso =
    typeof value === "string"
      ? value
      : value instanceof Date
        ? value.toISOString()
        : "";
  return iso.length >= 10 ? iso.slice(5, 10) : "";
}
