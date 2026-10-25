import { rcompare } from "semver";

import type { DashboardVersion } from "./types";

/**
 * "Latest version" for the product list, and the only definition of it.
 *
 * `semver` is a server dependency: this module must stay out of client component imports
 * (client code may import the *type* only; types are erased at build time).
 *
 * Versions are strict semver by contract, so ordering them is safe.
 */
export type VersionSummary = {
  version: string;
  /** False when the newest known row is still a candidate / under review. */
  published: boolean;
};

export function latestVersion(versions: DashboardVersion[]): VersionSummary | null {
  if (versions.length === 0) return null;

  const published = versions.filter((version) => version.state === "published");
  if (published.length > 0) {
    const newest = [...published].sort((a, b) => rcompare(a.version, b.version))[0]!;
    return { version: newest.version, published: true };
  }

  const newest = [...versions].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )[0]!;
  return { version: newest.version, published: false };
}
