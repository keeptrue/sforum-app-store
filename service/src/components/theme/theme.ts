/**
 * One source of truth for the three-state theme (light / dark / system).
 *
 * The root layout inlines `THEME_BOOTSTRAP` before first paint; `ThemeToggle` uses the
 * same constants after hydration. Keeping the storage key and the mode names here means
 * the pre-paint script and the React control cannot drift apart, and every face
 * (storefront, developer console, admin) reads the same preference.
 */

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "store-theme";
export const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];

export function parseThemeMode(value: string | null | undefined): ThemeMode | null {
  return value === "light" || value === "dark" || value === "system" ? value : null;
}

export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === "system") return systemPrefersDark ? "dark" : "light";
  return mode;
}

export function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function readThemeMode(): ThemeMode {
  try {
    return parseThemeMode(localStorage.getItem(THEME_STORAGE_KEY)) ?? "system";
  } catch {
    // Private mode: fall back to the OS preference rather than failing the control.
    return "system";
  }
}

/** Flips the document to match `mode` without touching storage. */
export function syncThemeDom(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode, systemPrefersDark());
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = mode;
  return resolved;
}

/** Applies `mode` and persists it; this is what the toggle calls. */
export function applyThemeMode(mode: ThemeMode): ResolvedTheme {
  const resolved = syncThemeDom(mode);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Storage failure only costs persistence; the live switch already happened.
  }
  return resolved;
}

/**
 * Pre-paint bootstrap. Re-reads storage on every media-query change so an explicit
 * light/dark choice is never overridden by the OS, while `system` keeps following it.
 */
export const THEME_BOOTSTRAP = `(function(){try{
var k=${JSON.stringify(THEME_STORAGE_KEY)};
var read=function(){var v=localStorage.getItem(k);return v==="light"||v==="dark"||v==="system"?v:"system";};
var q=window.matchMedia("(prefers-color-scheme: dark)");
var apply=function(){var m=read();var d=m==="dark"||(m==="system"&&q.matches);var r=document.documentElement;r.classList.toggle("dark",d);r.dataset.theme=m;};
apply();
if(q.addEventListener){q.addEventListener("change",apply);}else if(q.addListener){q.addListener(apply);}
}catch(e){}})();`;
