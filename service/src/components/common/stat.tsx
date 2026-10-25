import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type StatItem = {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
};

/**
 * A figure with its label. `card` is the dashboard tile; `bare` is the inline figure that
 * sits in a page header. Both use the display face and tabular numerals so columns of
 * numbers line up.
 */
export function Stat({
  label,
  value,
  hint,
  variant = "card",
  className,
}: StatItem & {
  variant?: "card" | "bare";
  className?: string;
}) {
  return (
    <div className={cn(variant === "card" ? "surface p-4" : "min-w-0", className)}>
      <p
        className={cn(
          "text-muted-foreground",
          variant === "card" ? "text-xs" : "text-[12.5px]",
        )}
      >
        {label}
      </p>
      <p
        className={cn(
          "font-display font-semibold tabular-nums tracking-tight",
          variant === "card" ? "mt-1 text-2xl" : "mt-0.5 text-xl leading-none",
        )}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-[12.5px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function StatGrid({
  items,
  className,
}: {
  items: StatItem[];
  className?: string;
}) {
  return (
    <div className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-4", className)}>
      {items.map((item, index) => (
        <Stat key={index} {...item} />
      ))}
    </div>
  );
}
