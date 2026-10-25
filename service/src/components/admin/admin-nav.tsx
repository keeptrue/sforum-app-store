"use client";

import { usePathname } from "next/navigation";

import { ADMIN_NAV, adminHref } from "@/components/admin/nav-items";
import { SidebarNav } from "@/components/shell/sidebar-nav";

/**
 * Sidebar links. Active state is derived from the pathname because the layout cannot know
 * which page is rendering; `matchPrefix` keeps a nested page (an issuer detail) lit.
 */
export function AdminNav({ base }: { base: string }) {
  const pathname = usePathname() ?? base;
  const relative = pathname.startsWith(base)
    ? pathname.slice(base.length).replace(/^\//, "")
    : "";

  const groups = ADMIN_NAV.map((group) => ({
    title: group.title,
    items: group.items.map((item) => ({
      href: adminHref(base, item.segment),
      label: item.label,
      icon: item.icon,
      active: item.matchPrefix
        ? relative === item.matchPrefix ||
          relative.startsWith(`${item.matchPrefix}/`)
        : relative === item.segment,
    })),
  }));

  return <SidebarNav groups={groups} label="后台导航" />;
}
