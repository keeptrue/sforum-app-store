import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Label + control + hint/error. Every form in the product uses this so the vertical
 * rhythm and the error placement are identical: blocking errors stay next to the field
 * that owns them, never in a toast that disappears.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="flex items-baseline gap-1 text-xs font-medium">
        {label}
        {required ? (
          <span className="text-destructive" aria-hidden>
            *
          </span>
        ) : null}
      </label>
      {children}
      {error ? (
        <p className="text-[13px] leading-relaxed text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-[13px] leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** Blocking form-level error. Stays put; it is not a toast. */
export function FormError({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      role="alert"
      className={cn(
        "rounded-control border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive",
        className,
      )}
    >
      {children}
    </p>
  );
}
