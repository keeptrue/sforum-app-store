import { requireModeratorSession } from "@/components/dashboard/session";
import { ConsoleShell } from "@/components/shell/console-shell";

/**
 * Moderation chrome, and the segment's authorization gate.
 *
 * The gate lives here rather than in the page so a stranger never sees the console frame
 * around the 404: a page-level check fires after the layout has already rendered the `审核台`
 * topbar. Anonymous visitors still get the OAuth flow — a 404 for them would just look broken.
 */
export default async function ModerationLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await requireModeratorSession();

  return (
    <ConsoleShell label="审核台" canModerate>
      {children}
    </ConsoleShell>
  );
}
