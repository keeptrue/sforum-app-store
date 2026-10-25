"use client";

import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export type SegmentedOption<T extends string> = {
  value: T;
  /** Accessible name; also used as the tooltip. */
  label: string;
  icon?: LucideIcon;
};

/**
 * Compact segmented control for small mutually-exclusive choices (theme, density, …).
 * Buttons carry `aria-pressed` rather than pretending to be a radiogroup: the control is
 * a group of toggles, and screen readers announce the current state on each one.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-pill border border-border bg-secondary p-0.5",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            title={option.label}
            aria-label={option.label}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "press grid size-7 place-items-center rounded-pill transition-colors",
              active
                ? "bg-card text-foreground shadow-[0_1px_2px_rgba(18,18,18,.12)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon ? (
              <Icon className="size-3.5" aria-hidden />
            ) : (
              <span className="px-1 text-[12.5px]">{option.label}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
