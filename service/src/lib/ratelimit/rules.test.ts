import { describe, expect, test } from "bun:test";

import { ConfigError } from "@/lib/config";
import {
  ADMIN_LOGIN_MIN_LIMIT,
  RATE_LIMIT_DEFAULTS,
  loadRateLimitRules,
  parseRuleSpec,
} from "./rules";

describe("rate limit rules", () => {
  test("parses <limit>/<seconds>", () => {
    expect(parseRuleSpec("10/300", "X")).toEqual({ limit: 10, windowSeconds: 300 });
    expect(parseRuleSpec(" 1/60 ", "X")).toEqual({ limit: 1, windowSeconds: 60 });
  });

  test("rejects anything else at boot instead of silently disabling the limit", () => {
    for (const raw of ["", "10", "10/", "/300", "10/0", "0/300", "ten/300", "10/300s"]) {
      expect(() => parseRuleSpec(raw, "STORE_RATELIMIT_LOGIN")).toThrow(ConfigError);
    }
  });

  test("defaults apply when the env is empty, env overrides when present", () => {
    const empty = loadRateLimitRules({} as NodeJS.ProcessEnv);
    expect(empty.login).toEqual(parseRuleSpec(RATE_LIMIT_DEFAULTS.login, "login"));
    expect(empty["download-token"]).toEqual(
      parseRuleSpec(RATE_LIMIT_DEFAULTS["download-token"], "download-token"),
    );

    const overridden = loadRateLimitRules({
      STORE_RATELIMIT_LOGIN: "2/60",
      STORE_RATELIMIT_SUBMIT: "5/120",
    } as NodeJS.ProcessEnv);
    expect(overridden.login).toEqual({ limit: 2, windowSeconds: 60 });
    expect(overridden.submit).toEqual({ limit: 5, windowSeconds: 120 });
  });

  test("clamps an admin-login limit that would lock the console out", () => {
    // The console refuses to save below the floor; env is clamped to it here so the two layers
    // cannot disagree about whether a lockout is configurable.
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: string) => warnings.push(message);
    try {
      const rules = loadRateLimitRules({
        STORE_RATELIMIT_ADMIN_LOGIN: "1/3600",
      } as NodeJS.ProcessEnv);
      expect(rules["admin-login"]).toEqual({
        limit: ADMIN_LOGIN_MIN_LIMIT,
        windowSeconds: 3600,
      });
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("STORE_RATELIMIT_ADMIN_LOGIN");
    } finally {
      console.warn = warn;
    }
  });
});
