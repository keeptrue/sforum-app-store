import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** One labelled block of the detail pane. Keeps the pane's rhythm on the 8px grid. */
export function ConsoleSection({
  title,
  hint,
  children,
  className,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("border-t border-border px-4 py-4 md:px-5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pb-2.5">
        <h3 className="flex items-center gap-2 text-xs font-semibold tracking-tight text-foreground">
          <span aria-hidden className="h-3 w-0.5 rounded-full bg-primary/70" />
          {title}
        </h3>
        {hint ? (
          <p className="text-[12.5px] tabular-nums text-muted-foreground">{hint}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}
