import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The one page header used by every face. Storefront, developer console and admin console
 * all render the same type scale and the same hairline rule, so a page never invents its
 * own header block.
 *
 * `leading` holds an optional mark (a product glyph, an avatar); `actions` sits on the
 * baseline of the title block and wraps on narrow viewports.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  leading,
  actions,
  meta,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-b border-border pb-5",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        {leading ? <div className="shrink-0">{leading}</div> : null}
        <div className="min-w-0">
          {eyebrow ? <p className="eyebrow mb-1.5">{eyebrow}</p> : null}
          <h1 className="page-title break-words">{title}</h1>
          {description ? (
            <p className="page-lede mt-1.5 max-w-2xl">{description}</p>
          ) : null}
          {meta ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted-foreground">
              {meta}
            </div>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">{actions}</div>
      ) : null}
    </header>
  );
}
