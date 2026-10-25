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

  test("prerelease versions only match prerelease comparators", () => {
    expect(satisfiesConstraint("1.1.0-beta.1", ">=1.0.0")).toBe(false);
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
