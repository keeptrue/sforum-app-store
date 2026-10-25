import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A titled block. `title` renders at the shared section scale; `hint` is the one-line
 * explanation that sits under it; `actions` is a right-aligned link or button.
 *
 * The heading id is derived from `id` so a page can point `aria-labelledby` at it.
 */
export function Section({
  id,
  title,
  hint,
  actions,
  children,
  className,
  bodyClassName,
}: {
  id?: string;
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("min-w-0", className)} aria-labelledby={id}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={id} className="section-title">
          {title}
        </h2>
        {actions ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {actions}
          </div>
        ) : null}
      </div>
      {hint ? <p className="page-lede mb-3">{hint}</p> : null}
      {children ? <div className={bodyClassName}>{children}</div> : null}
    </section>
  );
}
