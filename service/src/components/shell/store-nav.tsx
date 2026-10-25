"use client";

import { usePathname, useSearchParams } from "next/navigation";

import {
  SidebarNav,
  type SidebarNavGroup,
} from "@/components/shell/sidebar-nav";
import { CATEGORY_KEYS, CATEGORY_LABELS } from "@/lib/products/taxonomy";

const KINDS = [
  ["", "全部扩展"],
  ["plugin", "插件"],
  ["theme", "主题"],
] as const;

/**
 * The storefront rail is a filter menu, not a dashboard: every row is a link whose target
 * is a real catalog URL, so the active state survives reloads, sharing and Back. No row
 * carries a count — only the server query knows how many products a shelf holds, and a
 * number guessed from the current page would be a lie.
 */
export function StoreNav() {
  const pathname = usePathname();
  const params = useSearchParams();
  const onCatalog = pathname === "/";
  const activeKind = params.get("kind") ?? "";
  const activeCategory = params.get("category");

  const href = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params.toString());
    mutate(next);
    // Any filter change invalidates the keyset cursor.
    next.delete("cursor");
    const search = next.toString();
    return search ? `/?${search}` : "/";
  };

  const groups: SidebarNavGroup[] = [
    {
      items: [
        ...KINDS.map(([value, label]) => ({
          href: href((next) => {
            if (value) next.set("kind", value);
            else next.delete("kind");
          }),
          label,
          active: onCatalog && activeKind === value,
        })),
        {
          href: "/dashboard",
          label: "开发者门户",
          active: pathname.startsWith("/dashboard"),
        },
      ],
    },
    {
      title: "分类",
      items: CATEGORY_KEYS.map((key) => ({
        href: href((next) => {
          if (activeCategory === key) next.delete("category");
          else next.set("category", key);
        }),
        label: CATEGORY_LABELS[key],
        active: activeCategory === key,
        dot: true,
      })),
    },
  ];

  return <SidebarNav groups={groups} label="目录筛选" />;
}
