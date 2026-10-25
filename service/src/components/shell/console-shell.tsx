import { AppShell } from "@/components/shell/app-shell";
import { ConsoleNav } from "@/components/shell/console-nav";

/**
 * Frame for the developer portal and the moderation console. It is the storefront frame
 * with a different nav: the same rail, the same bar, the same theme switch, so moving from
 * browsing to publishing does not feel like leaving the product.
 *
 * `canModerate` is resolved by the layout from the session — the shell renders chrome, it
 * does not read cookies itself.
 */
export function ConsoleShell({
  label,
  canModerate,
  children,
}: {
  label: string;
  canModerate: boolean;
  children: React.ReactNode;
}) {
  return (
    <AppShell
      brand={{ href: "/", title: "SForum Store", subtitle: "工作台" }}
      nav={<ConsoleNav canModerate={canModerate} />}
      topbarStart={<span className="eyebrow hidden lg:block">{label}</span>}
      mainClassName="min-w-0"
    >
      {children}
    </AppShell>
  );
}
