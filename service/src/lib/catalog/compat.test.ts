import { describe, expect, test } from "bun:test";

import {
  compareVersionsDesc,
  constraintMatches,
  effectiveHostVersion,
  isDevBuild,
  maxVersion,
  parseConstraint,
  satisfiesConstraint,
} from "./compat";

describe("constraint parsing", () => {
  test("collapses the Masterminds comma separator", () => {
    expect(parseConstraint(">=1.2.0, <2.0.0")?.canonical).toBe(">=1.2.0 <2.0.0");
    expect(parseConstraint(">=1.2.0,<2.0.0")?.canonical).toBe(">=1.2.0 <2.0.0");
    expect(parseConstraint("  >=1.2.0 ,  <2.0.0  ")?.canonical).toBe(
      ">=1.2.0 <2.0.0",
    );
  });

  test("tightens an operator that was written with a space", () => {
    expect(parseConstraint(">= 1.2.0 < 2.0.0")?.canonical).toBe(">=1.2.0 <2.0.0");
  });

  test("keeps node-semver disjunction ranges", () => {
    expect(parseConstraint("<1.0.0 || >=2.0.0")?.groups).toHaveLength(2);
    expect(satisfiesConstraint("2.1.0", "<1.0.0 || >=2.0.0")).toBe(true);
    expect(satisfiesConstraint("1.5.0", "<1.0.0 || >=2.0.0")).toBe(false);
  });

  test("evaluates a conjunction", () => {
    const raw = ">=1.2.0, <2.0.0";
    expect(satisfiesConstraint("1.2.0", raw)).toBe(true);
    expect(satisfiesConstraint("1.5.0", raw)).toBe(true);
    expect(satisfiesConstraint("1.1.9", raw)).toBe(false);
    expect(satisfiesConstraint("2.0.0", raw)).toBe(false);
  });

  test("supports Masterminds != comparators", () => {
    const raw = ">=1.0.0, !=1.2.3";
    expect(satisfiesConstraint("1.2.3", raw)).toBe(false);
    expect(satisfiesConstraint("1.2.4", raw)).toBe(true);
    expect(satisfiesConstraint("0.9.0", raw)).toBe(false);

    const onlyExclusion = parseConstraint("!=1.2.3");
    expect(onlyExclusion).not.toBeNull();
    expect(constraintMatches(onlyExclusion!, "1.2.3")).toBe(false);
    expect(constraintMatches(onlyExclusion!, "9.9.9")).toBe(true);
  });

  test("rejects constraints that are not semver ranges", () => {
    expect(parseConstraint("not a range")).toBeNull();
    expect(parseConstraint(">=abc")).toBeNull();
    expect(parseConstraint("!=abc")).toBeNull();
    expect(parseConstraint("")).toBeNull();
    expect(parseConstraint("   ")).toBeNull();
    expect(parseConstraint(null)).toBeNull();
    expect(satisfiesConstraint("1.0.0", "not a range")).toBe(false);
  });

  test("a prerelease core still has to sit on a matching release line", () => {
    // Direct evaluation rejects 1.1.0-beta.1 against `>=1.0.0` (the group names no
    // prerelease), but the host retries the release baseline 1.1.0 and accepts it. A bound
    // on another line stays rejected - see the host-parity block below.
    expect(satisfiesConstraint("1.1.0-beta.1", ">=1.0.0")).toBe(true);
    expect(satisfiesConstraint("1.1.0-beta.1", ">=1.2.0")).toBe(false);
    expect(satisfiesConstraint("2.0.0-beta.1", ">=2.0.0-0 <3.0.0")).toBe(true);
    expect(satisfiesConstraint("2.5.0", ">=2.0.0-0 <3.0.0")).toBe(true);
    expect(parseConstraint(">=2.0.0-0 <3.0.0")?.canonical).toBe(">=2.0.0-0 <3.0.0");
  });

  test("evaluation never throws on garbage", () => {
    expect(satisfiesConstraint("not-a-version", ">=1.0.0")).toBe(false);
    expect(satisfiesConstraint("1.0.0", "!!!")).toBe(false);
  });
});

describe("effective host version", () => {
  test("uses a strict semver core version as-is", () => {
    expect(effectiveHostVersion("1.5.0", null)).toEqual({
      version: "1.5.0",
      estimated: false,
    });
    expect(effectiveHostVersion("2.0.0-beta.1", "release-7")).toEqual({
      version: "2.0.0-beta.1",
      estimated: false,
    });
  });

  test("treats non-semver core versions as unknown", () => {
    expect(effectiveHostVersion(null, null)).toEqual({
      version: null,
      estimated: false,
    });
    expect(effectiveHostVersion("1.5", null)).toEqual({ version: null, estimated: false });
    expect(effectiveHostVersion("dev", null)).toEqual({ version: null, estimated: false });
    expect(effectiveHostVersion("garbage", "release-1")).toEqual({
      version: null,
      estimated: false,
    });
  });

  test("estimates 1.0.0 for dev builds", () => {
    expect(isDevBuild("dev")).toBe(true);
    expect(isDevBuild("dev-abc12")).toBe(true);
    expect(isDevBuild("release-1")).toBe(false);
    expect(isDevBuild(null)).toBe(false);

    expect(effectiveHostVersion(null, "dev")).toEqual({
      version: "1.0.0",
      estimated: true,
    });
    expect(effectiveHostVersion("garbage", "dev-abc12")).toEqual({
      version: "1.0.0",
      estimated: true,
    });
  });

  test("keeps the real version but still flags a dev build as estimated", () => {
    expect(effectiveHostVersion("2.1.0", "dev-abc12")).toEqual({
      version: "2.1.0",
      estimated: true,
    });
  });
});

describe("prerelease core baselines (host parity)", () => {
  // The host's `CheckSForumVersion` does two things node-semver does not: it compares a
  // prerelease core against every comparator once the OR-group names a prerelease, and it
  // retries the release baseline (`major.minor.patch`) when the direct evaluation fails.
  // The store mirrors both; without them a dev core is hidden from packages the host would
  // install (verified against Masterminds v3.5.0, the version `apps/api/go.mod` pins).

  test("a prerelease core matches a bound from an earlier line", () => {
    // node-semver alone rejects this: the version's tuple (3.0.13) differs from the only
    // prerelease comparator (3.0.12). The host compares directly, so the store must too.
    expect(satisfiesConstraint("3.0.13-alpha.2", ">=3.0.12-alpha.7")).toBe(true);
    expect(satisfiesConstraint("3.0.13-alpha.2", "^3.0.12-alpha.7")).toBe(true);
    expect(satisfiesConstraint("3.0.13-alpha.2", "~3.0.12-alpha.7")).toBe(true);
  });

  test("the retry only relaxes within the same release line", () => {
    expect(satisfiesConstraint("3.0.13-alpha.2", "^1.0.0")).toBe(false);
    expect(satisfiesConstraint("3.0.13-alpha.2", ">=4.0.0")).toBe(false);
    expect(satisfiesConstraint("3.0.13-alpha.2", ">=3.0.12 <3.0.13")).toBe(false);
  });

  test("a plain release constraint accepts a prerelease core of the same line", () => {
    // The group names no prerelease, so the first evaluation ignores prereleases entirely;
    // the baseline retry is what makes such a core installable at all.
    expect(satisfiesConstraint("3.0.13-alpha.2", ">=3.0.12")).toBe(true);
    expect(satisfiesConstraint("3.0.13-alpha.2", ">=3.0.12 <4.0.0")).toBe(true);
  });

  test("the baseline satisfies bounds the prerelease itself fails", () => {
    // alpha.2 is below alpha.5, so the direct comparison fails; the host then checks the
    // release baseline 3.0.13, which does satisfy `>=3.0.13-alpha.5`.
    expect(satisfiesConstraint("3.0.13-alpha.2", ">=3.0.13-alpha.5")).toBe(true);
  });

  test("a group that names a prerelease compares every comparator", () => {
    // `<3.0.13` accepts 3.0.13-alpha.2 only once prereleases are compared directly.
    expect(satisfiesConstraint("3.0.13-alpha.2", ">=3.0.12-alpha.7 <3.0.13")).toBe(true);
  });

  test("build metadata does not disturb the release path", () => {
    expect(satisfiesConstraint("3.0.16+13.gabc", ">=3.0.12-alpha.7")).toBe(true);
    expect(satisfiesConstraint("3.0.16+13.gabc", ">=3.0.12 <4.0.0")).toBe(true);
    expect(satisfiesConstraint("3.0.16+13.gabc", ">=3.0.17")).toBe(false);
  });

  test("exclusions apply to both evaluations", () => {
    // `!=3.0.13` does not exclude the prerelease (the host compares equality, and
    // 3.0.13-alpha.2 is not 3.0.13), but it does exclude the baseline, so the retry cannot
    // smuggle the version back in.
    expect(satisfiesConstraint("3.0.13-alpha.2", ">=3.0.12-alpha.7 !=3.0.13")).toBe(true);
    expect(satisfiesConstraint("3.0.13-alpha.2", ">=3.0.12 !=3.0.13")).toBe(false);
    expect(satisfiesConstraint("3.0.13-alpha.2", ">=3.0.12 !=3.0.13-alpha.2")).toBe(true);
  });
});

describe("version ordering helpers", () => {
  test("maxVersion ignores unparsable versions", () => {
    expect(maxVersion(["1.0.0", "1.10.0", "1.9.9"])).toBe("1.10.0");
    expect(maxVersion(["1.0.0", "nonsense"])).toBe("1.0.0");
    expect(maxVersion(["nonsense"])).toBeNull();
    expect(maxVersion([])).toBeNull();
  });

  test("compareVersionsDesc sorts descending and sinks garbage", () => {
    expect(["1.0.0", "2.0.0", "1.5.0"].sort(compareVersionsDesc)).toEqual([
      "2.0.0",
      "1.5.0",
      "1.0.0",
    ]);
    expect(["bogus", "1.0.0"].sort(compareVersionsDesc)).toEqual(["1.0.0", "bogus"]);
  });
});
