import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CapabilityDiff } from "./capability-diff";

/**
 * The console shows the host's labels and tiers next to the keys it already gates on.
 * These tests pin the two things that must not drift: a new key still holds the version
 * (the gate has no tiers), and an unknown key never borrows a tier it does not have.
 */

function version(capabilities: string[]) {
  return {
    id: "v1",
    version: "1.2.0",
    channel: "stable" as const,
    state: "pending_review" as const,
    sforumVersion: ">=1.0.0",
    capabilities,
    publishedAt: null,
    yankedAt: null,
    yankReason: null,
    createdAt: "2026-10-25T00:00:00.000Z",
    assetPlatforms: [],
  };
}

function render(capabilities: string[], approved: string[], firstReview = false): string {
  return renderToStaticMarkup(
    createElement(CapabilityDiff, { version: version(capabilities), approved, firstReview }),
  );
}

describe("CapabilityDiff", () => {
  test("names the pending keys with the host tier and holds the version", () => {
    const html = render(["host.api", "users.read"], ["host.api"]);
    expect(html).toContain("users.read");
    expect(html).toContain("读取用户信息");
    expect(html).toContain("高风险");
    expect(html).toContain("调用宿主 API");
    expect(html).toContain("低风险");
    expect(html).toContain("未审 1 项，其中 1 项高风险");
    expect(html).toContain("未审过的能力键是这次版本被留下的原因");
  });

  test("orders both columns high risk first, so the rows line up", () => {
    const html = render(["host.api", "users.read"], ["host.api", "users.read"]);
    expect(html.indexOf("users.read")).toBeLessThan(html.indexOf("host.api"));
  });

  test("a key outside the vendored catalog is shown as unreviewed, without a tier", () => {
    const html = render(["brand.new.capability"], [], true);
    expect(html).toContain("brand.new.capability");
    expect(html).toContain("未收录");
    expect(html).toContain("宿主目录暂无此键的释义");
    expect(html).not.toContain("高风险");
  });

  test("an unchanged version says so instead of inventing pending work", () => {
    const html = render(["host.api"], ["host.api"]);
    expect(html).toContain("本版本没有未审过的能力键");
  });
});
