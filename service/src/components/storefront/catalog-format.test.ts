import { describe, expect, test } from "bun:test";

import {
  badgeForCompatibility,
  constraintChip,
  describeCompatibility,
  formatMonthDay,
  UNJUDGED_LABEL,
} from "./catalog-format";

const UNKNOWN = { status: "unknown" as const, estimated: false };

describe("compatibility badges", () => {
  test("only a real verdict earns a badge", () => {
    // `unknown` is a statement about the request (no host version), so the card stays
    // silent and the page says it once. This is the regression guard for the constant
    // 「未校验」 that used to sit on every card.
    expect(badgeForCompatibility(UNKNOWN)).toBeNull();
    expect(badgeForCompatibility({ status: "unknown", estimated: false })).toBeNull();
  });

  test("a dev-build estimate is never phrased as a verdict", () => {
    expect(badgeForCompatibility({ status: "compatible", estimated: true })).toEqual({
      label: "按开发版估算",
      variant: "warning",
    });
  });

  test("compatible and incompatible keep their hints", () => {
    expect(badgeForCompatibility({ status: "compatible", estimated: false })).toEqual({
      label: "兼容",
      variant: "success",
      hint: undefined,
    });
    expect(
      badgeForCompatibility({
        status: "compatible",
        estimated: false,
        constraint: ">=1.2.0, <2.0.0",
      }),
    ).toEqual({
      label: "兼容",
      variant: "success",
      hint: "命中约束 >=1.2.0, <2.0.0",
    });
    expect(
      badgeForCompatibility({
        status: "incompatible",
        estimated: false,
        constraint: ">=3.0.0",
      }),
    ).toEqual({
      label: "不兼容",
      variant: "destructive",
      hint: "宿主不满足 >=3.0.0",
    });
  });
});

describe("the page-level sentence", () => {
  test("explains an absent host version once, without a verdict", () => {
    const text = describeCompatibility(UNKNOWN, undefined);
    expect(text).toContain("未提供论坛版本");
    expect(text).toContain("sforumVersion");
    expect(text).not.toContain("未校验");
  });

  test("names what the filter actually did", () => {
    const known = { status: "compatible" as const, estimated: false };
    expect(describeCompatibility(known, undefined)).toBe("已按宿主 sforumVersion 过滤");
    expect(describeCompatibility(known, "all")).toBe(
      "已按宿主 sforumVersion 校验，未按兼容性过滤",
    );
    expect(describeCompatibility({ status: "compatible", estimated: true }, undefined)).toBe(
      "宿主版本为开发版，兼容性按开发版估算",
    );
  });
});

describe("constraint chip", () => {
  test("empty constraints render nothing", () => {
    expect(constraintChip(null)).toBeNull();
    expect(constraintChip(undefined)).toBeNull();
    expect(constraintChip("   ")).toBeNull();
  });

  test("the raw constraint is kept, only the layout is truncated", () => {
    expect(constraintChip(">=1.2.0")).toEqual({ text: ">=1.2.0", title: ">=1.2.0" });
    // Operators are never rewritten: the detail page prints the same string.
    const long = constraintChip(">=3.0.12-alpha.7 <4.0.0");
    expect(long).toEqual({ text: ">=3.0.12-alpha.7 …", title: ">=3.0.12-alpha.7 <4.0.0" });
    expect(long?.text.length).toBe(18);
  });
});

test("an unjudged surface has one word for it", () => {
  expect(UNJUDGED_LABEL).toBe("未判定");
});

test("month-day labels survive a missing timestamp", () => {
  expect(formatMonthDay("2026-10-24T00:00:00.000Z")).toBe("10-24");
  expect(formatMonthDay(null)).toBe("");
  expect(formatMonthDay("")).toBe("");
});
