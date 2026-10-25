import type { LucideIcon } from "lucide-react";
import {
  Activity,
  FileClock,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  Package,
  Settings2,
  SlidersHorizontal,
  Users,
} from "lucide-react";

export type AdminNavItem = {
  /** Path relative to the admin base, e.g. `accounts`. Empty string is the overview. */
  segment: string;
  label: string;
  icon: LucideIcon;
  /** Match nested paths (e.g. `settings/issuers/foo`) against this prefix. */
  matchPrefix?: string;
};

export type AdminNavGroup = {
  title: string;
  items: AdminNavItem[];
};

/**
 * Console navigation, grouped by how often it is touched: daily operations first,
 * configuration last. Icons come from Lucide only (AGENTS.md) and every item carries a
 * text label — the icon never stands alone.
 */
export const ADMIN_NAV: AdminNavGroup[] = [
  {
    title: "运营",
    items: [
      { segment: "", label: "概览", icon: LayoutDashboard },
      { segment: "accounts", label: "账号与角色", icon: Users },
      { segment: "audit", label: "审计日志", icon: FileClock },
      { segment: "products", label: "全局产品", icon: Package },
      { segment: "system", label: "系统健康", icon: Activity },
    ],
  },
  {
    title: "配置",
    items: [
      {
        segment: "settings/general",
        label: "系统设置",
        icon: Settings2,
        matchPrefix: "settings/general",
      },
      {
        segment: "settings/issuers",
        label: "OAuth2 配置",
        icon: KeyRound,
        matchPrefix: "settings/issuers",
      },
      {
        segment: "settings/policy",
        label: "发布策略",
        icon: SlidersHorizontal,
        matchPrefix: "settings/policy",
      },
      {
        segment: "settings/github",
        label: "GitHub App",
        icon: GitBranch,
        matchPrefix: "settings/github",
      },
    ],
  },
];

export function adminHref(base: string, segment: string): string {
  return segment ? `${base}/${segment}` : base;
}
