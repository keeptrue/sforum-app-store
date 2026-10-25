import { redirect } from "next/navigation";

import { AdminShell } from "@/components/admin/admin-shell";
import { getDb } from "@/db/client";
import { getAdminSession } from "@/lib/admin/guard";
import { hasAdmin } from "@/lib/admin/setup";
import { getConfig } from "@/lib/config";

/**
 * Session gate for every console page.
 *
 * No session → login (or setup when the store has no administrator at all). A session that
 * still owes a password change → the password page, and nowhere else: an initial password
 * handed over by another admin must not survive a single click into the console.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const config = getConfig();
  const base = `/${config.adminPath}`;
  const db = getDb();
  const session = await getAdminSession(db);

  if (!session) {
    redirect(`${base}/${(await hasAdmin(db)) ? "login" : "setup"}`);
  }
  if (session.admin.mustChangePassword) redirect(`${base}/password`);

  const name = session.admin.displayName?.trim() || session.admin.username;

  return (
    <AdminShell base={base} adminName={name}>
      {children}
    </AdminShell>
  );
}
