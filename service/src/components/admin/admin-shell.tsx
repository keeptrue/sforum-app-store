import { AdminNav } from "@/components/admin/admin-nav";
import { AdminSignOut } from "@/components/admin/admin-sign-out";
import { AppShell } from "@/components/shell/app-shell";

/**
 * Admin console frame.
 *
 * It is the storefront frame — same 248px rail, same brand block, same active-link style,
 * same bar and theme switch — with the admin nav and an identity card in the rail. The
 * console reads as another room of the same product, not a separate tool.
 *
 * The shell renders no data of its own; every page owns its queries so a slow panel cannot
 * hold up the navigation.
 */
export function AdminShell({
  base,
  adminName,
  children,
}: {
  base: string;
  adminName: string;
  children: React.ReactNode;
}) {
  return (
    <AppShell
      brand={{ href: base, title: "SForum Store", subtitle: "管理员后台" }}
      nav={<AdminNav base={base} />}
      railFooter={
        <div className="rounded-cup border border-border bg-card p-3">
          <p className="truncate text-xs font-medium">{adminName}</p>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            本地管理员账号
          </p>
          <div className="mt-2">
            <AdminSignOut base={base} />
          </div>
        </div>
      }
      topbarStart={<span className="eyebrow hidden lg:block">管理员后台</span>}
      mainClassName="mx-auto w-full max-w-[1180px] px-5 pb-16 pt-7"
    >
      {children}
    </AppShell>
  );
}
