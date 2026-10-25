import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CAPABILITY_CATALOG_PROVENANCE,
  CAPABILITY_RISK_BADGE,
  CAPABILITY_RISK_LABELS,
  capabilityBreakdown,
  capabilityEntry,
  describeCapabilities,
  summarizeCapabilities,
} from "./catalog";
import lock from "./catalog.lock.json";

const here = import.meta.dir;

describe("vendored catalog", () => {
  test("catalog.json is exactly what the lock recorded", () => {
    const body = readFileSync(join(here, "catalog.json"));
    expect(createHash("sha256").update(body).digest("hex")).toBe(lock.sha256);
    expect(body.byteLength).toBe(lock.bytes);
  });

  test("every row carries a host tier and both labels", () => {
    const rows = JSON.parse(readFileSync(join(here, "catalog.json"), "utf8")) as {
      entries: { key: string; risk: string; labelZh: string; labelEn: string }[];
    };
    expect(rows.entries.length).toBe(lock.entries);
    for (const row of rows.entries) {
      expect(["low", "medium", "high"]).toContain(row.risk);
      expect(row.labelZh.length).toBeGreaterThan(0);
      expect(row.labelEn.length).toBeGreaterThan(0);
    }
  });

  test("provenance points at the host catalog document, not at this repo", () => {
    expect(CAPABILITY_CATALOG_PROVENANCE.source).toBe(
      "docs/extensions/catalogs/capabilities.md",
    );
    expect(CAPABILITY_CATALOG_PROVENANCE.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(CAPABILITY_CATALOG_PROVENANCE.commitShort).toHaveLength(7);
  });
});

describe("capabilityEntry", () => {
  test("reads the host tier and Chinese label verbatim", () => {
    expect(capabilityEntry("users.read")).toEqual({
      key: "users.read",
      known: true,
      risk: "high",
      labelZh: "读取用户信息",
      labelEn: "Read user profiles",
      description: expect.stringContaining("non-secret user fields"),
    });
    expect(capabilityEntry("host.api").risk).toBe("low");
    expect(capabilityEntry("settings.own").risk).toBe("low");
  });

  test("a key outside the vendored catalog gets no tier at all", () => {
    expect(capabilityEntry("something.new")).toEqual({
      key: "something.new",
      known: false,
      risk: null,
      labelZh: null,
      labelEn: null,
      description: null,
    });
  });
});

describe("describeCapabilities", () => {
  test("orders like the host enable review: high, medium, low, then unknown", () => {
    const entries = describeCapabilities([
      "settings.own", // low
      "something.new", // unknown
      "users.read", // high
      "jobs.enqueue", // medium
      "users.email.read", // high
      "host.api", // low
    ]);
    expect(entries.map((entry) => entry.key)).toEqual([
      "users.email.read",
      "users.read",
      "jobs.enqueue",
      "host.api",
      "settings.own",
      "something.new",
    ]);
    expect(entries.at(-1)?.known).toBe(false);
  });

  test("collapses duplicates and keeps an empty release empty", () => {
    expect(describeCapabilities(["host.api", "host.api"]).map((entry) => entry.key)).toEqual([
      "host.api",
    ]);
    expect(describeCapabilities([])).toEqual([]);
  });
});

describe("summarizeCapabilities", () => {
  test("counts tiers, unknowns and the highest tier present", () => {
    const summary = summarizeCapabilities(
      describeCapabilities(["host.api", "settings.own", "users.read", "something.new"]),
    );
    expect(summary).toEqual({
      total: 4,
      known: 3,
      unknown: 1,
      byRisk: { low: 2, medium: 0, high: 1 },
      maxRisk: "high",
    });
  });

  test("unknown keys alone do not invent a tier", () => {
    expect(summarizeCapabilities(describeCapabilities(["foo.bar"])).maxRisk).toBeNull();
    expect(capabilityBreakdown([]).summary).toEqual({
      total: 0,
      known: 0,
      unknown: 0,
      byRisk: { low: 0, medium: 0, high: 0 },
      maxRisk: null,
    });
  });

  test("every tier has a Chinese label and a badge variant", () => {
    expect(CAPABILITY_RISK_LABELS).toEqual({
      low: "低风险",
      medium: "中风险",
      high: "高风险",
    });
    expect(CAPABILITY_RISK_BADGE).toEqual({
      low: "success",
      medium: "warning",
      high: "destructive",
    });
  });
});
