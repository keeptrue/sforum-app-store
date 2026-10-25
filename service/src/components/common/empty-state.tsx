import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The shared "nothing here yet" block. A dashed outline rather than a filled card keeps an
 * empty region from reading as content; the icon is decorative and the copy carries the
 * meaning.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact = false,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "surface-dashed grid place-items-center text-center",
        compact ? "px-5 py-8" : "px-5 py-16",
        className,
      )}
    >
      <div className="max-w-sm">
        {Icon ? (
          <Icon
            className="mx-auto mb-2 size-5 text-muted-foreground"
            strokeWidth={1.7}
            aria-hidden
          />
        ) : null}
        <p className="text-sm font-medium">{title}</p>
        {description ? (
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
        {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
      </div>
    </div>
  );
}
