import { describe, expect, test } from "bun:test";

import { decideReleaseState, type ReleaseDecisionInput } from "./policy";

const base: ReleaseDecisionInput = {
  productStatus: "published",
  productName: "Markdown Plus",
  nameAtReview: "Markdown Plus",
  repoId: 42,
  repoIdReviewed: 42,
  capabilitiesReviewed: ["host.api", "settings.own"],
  versionCapabilities: ["host.api"],
};

describe("release auto-publish policy", () => {
  test("publishes when nothing changed since the approval", () => {
    expect(decideReleaseState(base)).toEqual({
      state: "published",
      reason: "approved",
      unknownCapabilities: [],
    });
  });

  test("holds the first release of an unpublished product", () => {
    const decision = decideReleaseState({ ...base, productStatus: "draft" });
    expect(decision.state).toBe("pending_review");
    expect(decision.reason).toBe("product_not_published");
  });

  test("holds when the product predates the review snapshot", () => {
    expect(
      decideReleaseState({ ...base, nameAtReview: null, repoIdReviewed: null }).reason,
    ).toBe("snapshot_missing");
    expect(decideReleaseState({ ...base, nameAtReview: null }).state).toBe("pending_review");
  });

  test("holds when the product was renamed after approval", () => {
    const decision = decideReleaseState({ ...base, productName: "Markdown Plus Pro" });
    expect(decision).toMatchObject({ state: "pending_review", reason: "renamed_since_review" });
  });

  test("holds when the repository binding changed", () => {
    const decision = decideReleaseState({ ...base, repoId: 43 });
    expect(decision).toMatchObject({ state: "pending_review", reason: "repo_changed" });
  });

  test("holds on any capability the moderator never saw", () => {
    const decision = decideReleaseState({
      ...base,
      versionCapabilities: ["host.api", "net.outbound", "content.render"],
    });
    expect(decision.state).toBe("pending_review");
    expect(decision.reason).toBe("unknown_capabilities");
    expect(decision.unknownCapabilities).toEqual(["net.outbound", "content.render"]);
  });

  test("a subset of reviewed capabilities still publishes", () => {
    const decision = decideReleaseState({
      ...base,
      versionCapabilities: ["settings.own"],
    });
    expect(decision.state).toBe("published");
  });

  test("an empty capability set publishes", () => {
    expect(decideReleaseState({ ...base, versionCapabilities: [] }).state).toBe("published");
  });
});
