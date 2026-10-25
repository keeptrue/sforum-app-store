import { ConsoleShell } from "@/components/shell/console-shell";
import { canModerate, readConsoleSession } from "@/components/dashboard/session";

/** Developer portal chrome — the shared frame with the workbench nav. */
export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Read for the nav only: a signed-out visitor still gets the frame, and the page decides
  // whether to send them through the OAuth flow.
  const session = await readConsoleSession();

  return (
    <ConsoleShell label="开发者门户" canModerate={canModerate(session)}>
      {children}
    </ConsoleShell>
  );
}
