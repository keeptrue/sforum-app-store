"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

import {
  applyThemeMode,
  parseThemeMode,
  readThemeMode,
  syncThemeDom,
  THEME_STORAGE_KEY,
  type ThemeMode,
} from "@/components/theme/theme";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented";

const OPTIONS: readonly SegmentedOption<ThemeMode>[] = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
];

/**
 * Light / dark / system switch. The class on <html> stays the single rendering switch;
 * this control only decides which mode wins. It also follows OS changes while in system
 * mode and mirrors a change made in another tab.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [mode, setMode] = useState<ThemeMode>("system");

  useEffect(() => {
    setMode(readThemeMode());

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => {
      if (readThemeMode() === "system") syncThemeDom("system");
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = parseThemeMode(event.newValue) ?? "system";
      setMode(next);
      syncThemeDom(next);
    };

    media.addEventListener("change", onSystemChange);
    window.addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener("change", onSystemChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return (
    <SegmentedControl
      label="主题"
      value={mode}
      options={OPTIONS}
      onChange={(next) => {
        setMode(next);
        applyThemeMode(next);
      }}
      className={className}
    />
  );
}
