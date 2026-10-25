import semver from "semver";

export {
  constraintMatches,
  parseConstraint,
  satisfiesConstraint,
  type ConstraintGroup,
  type ParsedConstraint,
} from "@/lib/semver-constraint";

export type HostVersion = {
  /** Effective host version used for constraint evaluation; null means "unknown". */
  version: string | null;
  /** True when a `dev` build forced the 1.0.0 estimate (plan Q6). */
  estimated: boolean;
};

export function isDevBuild(sforumBuild: string | null | undefined): boolean {
  return typeof sforumBuild === "string" && sforumBuild.startsWith("dev");
}

/**
 * `sforum` is the host `CoreCompatibilityVersion()`: the contract demands strict semver,
 * but the host does not enforce it, so the store validates it. `sforumBuild` only flags
 * dev builds and supplies the 1.0.0 estimate when `sforum` is unusable.
 */
export function effectiveHostVersion(
  sforum: string | null | undefined,
  sforumBuild: string | null | undefined,
): HostVersion {
  const valid = typeof sforum === "string" ? semver.valid(sforum.trim()) : null;
  const estimated = isDevBuild(sforumBuild);
  if (valid !== null) return { version: valid, estimated };
  if (estimated) return { version: "1.0.0", estimated: true };
  return { version: null, estimated: false };
}

/** Highest strict semver in the list; non-semver inputs are skipped, never compared. */
export function maxVersion(versions: readonly string[]): string | null {
  let best: string | null = null;
  for (const version of versions) {
    if (semver.valid(version) === null) continue;
    if (best === null || semver.gt(version, best)) best = version;
  }
  return best;
}

/** Descending semver order; unparsable versions sink to the bottom instead of throwing. */
export function compareVersionsDesc(a: string, b: string): number {
  const aValid = semver.valid(a) !== null;
  const bValid = semver.valid(b) !== null;
  if (aValid && bValid) return semver.rcompare(a, b);
  if (aValid) return -1;
  if (bValid) return 1;
  return a < b ? 1 : a > b ? -1 : 0;
}
