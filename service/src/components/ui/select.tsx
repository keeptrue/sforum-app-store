import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Native `<select>` in the Nova compact shape.
 *
 * The dashboard needs real option lists (category, kind) and this kit has no Select
 * primitive. A native control keeps keyboard handling, screen-reader semantics and mobile
 * pickers correct without pulling in another dependency.
 */
function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <span className="relative block w-full">
      <select
        data-slot="select"
        className={cn(
          "flex h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent py-1 pr-7 pl-2.5 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}

export { Select };
