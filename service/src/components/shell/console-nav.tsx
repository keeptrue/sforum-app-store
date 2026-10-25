"use client";

import { usePathname } from "next/navigation";

import { SidebarNav } from "@/components/shell/sidebar-nav";

type ConsoleLink = {
  href: string;
  label: string;
  /** Matches only the exact path — the catalog has nested routes that are not "current". */
  exact?: boolean;
  /** Rendered only for a moderator; the console itself 404s for everyone else. */
  moderatorOnly?: boolean;
};

const LINKS: ConsoleLink[] = [
  { href: "/", label: "目录", exact: true },
  { href: "/dashboard", label: "开发者门户" },
  // A visible link that always 404s is a promise the product does not keep, so the entry is
  // gated here as well as on the page (components/dashboard/session.ts#canModerate).
  { href: "/moderation", label: "审核台", moderatorOnly: true },
];

/** Developer + moderator navigation. Same rail renderer as the catalog and the admin console. */
export function ConsoleNav({ canModerate }: { canModerate: boolean }) {
  const pathname = usePathname() ?? "/";
  const links = LINKS.filter((link) => !link.moderatorOnly || canModerate);

  return (
    <SidebarNav
      label="工作台导航"
      groups={[
        {
          items: links.map((link) => ({
            href: link.href,
            label: link.label,
            active: link.exact
              ? pathname === link.href
              : pathname === link.href || pathname.startsWith(`${link.href}/`),
          })),
        },
      ]}
    />
  );
}
