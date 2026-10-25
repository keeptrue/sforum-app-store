import type { LucideIcon } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/utils";

export type SidebarNavItem = {
  href: string;
  label: string;
  icon?: LucideIcon;
  /** Rendered as the current page (`aria-current`). The caller decides, not this component. */
  active?: boolean;
  /** Small dot instead of an icon — the category-shelf treatment. */
  dot?: boolean;
};

export type SidebarNavGroup = {
  title?: string;
  items: SidebarNavItem[];
};

/**
 * The rail's link list, shared by the storefront, the developer console and the admin
 * console. It is deliberately presentational: each face computes `active` from its own
 * source of truth (search params for the catalog, pathname for the consoles) and passes
 * groups in. One active style, one row height, one hover.
 */
export function SidebarNav({
  groups,
  label = "主导航",
  className,
}: {
  groups: SidebarNavGroup[];
  label?: string;
  className?: string;
}) {
  return (
    <nav aria-label={label} className={cn("grid gap-0.5", className)}>
      {groups.map((group, groupIndex) => (
        <div
          key={group.title ?? `group-${groupIndex}`}
          className={cn("grid gap-0.5", groupIndex > 0 && "mt-4")}
        >
          {group.title ? (
            <h2 className="eyebrow mx-2.5 mb-1.5">{group.title}</h2>
          ) : null}
          {group.items.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={`${item.href}-${item.label}`}
                href={item.href}
                aria-current={item.active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-[9px] rounded-control px-2.5 py-2.5 text-[14px] transition-colors",
                  item.active
                    ? "bg-card font-medium text-foreground shadow-[0_1px_2px_rgba(18,18,18,.07)]"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {item.dot ? (
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      item.active
                        ? "bg-primary ring-[3px] ring-primary/15"
                        : "bg-foreground/25",
                    )}
                  />
                ) : null}
                {Icon ? <Icon className="size-4 shrink-0" aria-hidden /> : null}
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
