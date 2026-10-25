import { describe, expect, test } from "bun:test";

import {
  parseThemeMode,
  resolveTheme,
  THEME_BOOTSTRAP,
  THEME_MODES,
  THEME_STORAGE_KEY,
} from "./theme";

describe("theme modes", () => {
  test("accepts only the three known modes", () => {
    expect(parseThemeMode("light")).toBe("light");
    expect(parseThemeMode("dark")).toBe("dark");
    expect(parseThemeMode("system")).toBe("system");
    expect(parseThemeMode("Dark")).toBeNull();
    expect(parseThemeMode("")).toBeNull();
    expect(parseThemeMode(null)).toBeNull();
    expect(parseThemeMode(undefined)).toBeNull();
  });

  test("system follows the OS preference; explicit modes do not", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("the pre-paint script and the toggle share one storage key", () => {
    expect(THEME_STORAGE_KEY).toBe("store-theme");
    expect(THEME_BOOTSTRAP).toContain(JSON.stringify(THEME_STORAGE_KEY));
    for (const mode of THEME_MODES) {
      expect(THEME_BOOTSTRAP).toContain(`"${mode}"`);
    }
  });

  test("the bootstrap applies the class, records the mode and follows OS changes", () => {
    // The script is a string injected before first paint; these are its contract points.
    expect(THEME_BOOTSTRAP).toContain("classList.toggle(\"dark\"");
    expect(THEME_BOOTSTRAP).toContain("dataset.theme");
    expect(THEME_BOOTSTRAP).toContain("prefers-color-scheme: dark");
    expect(THEME_BOOTSTRAP).toContain("addEventListener(\"change\"");
    // An explicit choice must never be overridden by the media query listener.
    expect(THEME_BOOTSTRAP).toContain('m==="dark"||(m==="system"&&q.matches)');
  });
});
