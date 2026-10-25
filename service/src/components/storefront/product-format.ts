import type { ReleaseVersion } from "@/lib/catalog/query";

/**
 * Presentation helpers for one product detail. Pure: no React, no data lookup — the
 * page passes values it already read from `ProductDetail`.
 */

export function splitPlatform(key: string): { os: string; arch: string } {
  const [os = "", arch = ""] = key.split("/");
  return { os, arch };
}

/** Multi-platform releases have no single digest (contract `ReleaseVersion.digest`). */
export function digestPreview(release: ReleaseVersion): string {
  return release.digest ? `${release.digest.slice(0, 12)}…` : "—";
}

export function statusLabel(release: ReleaseVersion): string {
  if (release.status === "yanked") return "已撤回";
  if (release.status === "needs_attention") return "需注意";
  return "已发布";
}

export function statusVariant(
  release: ReleaseVersion,
): "success" | "destructive" | "warning" {
  if (release.status === "yanked") return "destructive";
  if (release.status === "needs_attention") return "warning";
  return "success";
}

/**
 * Why the download CTA is off. The browser route always signs the product's latest stable
 * release (`issueDownloadUrl` with `version: null`), so an older selection cannot be served
 * by it — saying so is better than handing out a link for a different version.
 */
export function blockedReason(
  selected: ReleaseVersion | null,
  asset: ReleaseVersion["assets"][number] | null,
  routeRelease: ReleaseVersion | null,
): string {
  if (!selected) return "该产品还没有可下载的版本。";
  if (selected.status === "yanked") return "该版本已撤回，商城不再签发下载链接。";
  if (!asset) return "该版本没有所选平台的资产；换一个平台或版本。";
  if (!routeRelease) return "该产品没有已发布的 stable 版本，浏览器入口不签发链接。";
  return `浏览器入口只签发最新稳定版 ${routeRelease.version}；所选 ${selected.version} 的摘要用于核对已取到的包。`;
}

export function formatBytes(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(value / 1024)} KB`;
}

/** YYYY-MM-DD. Slicing the ISO string keeps SSR output and the client in agreement. */
export function formatDay(value: string | Date | null | undefined): string {
  const iso =
    typeof value === "string"
      ? value
      : value instanceof Date
        ? value.toISOString()
        : "";
  return iso.length >= 10 ? iso.slice(0, 10) : "—";
}
