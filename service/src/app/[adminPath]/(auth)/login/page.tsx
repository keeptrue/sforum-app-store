import { redirect } from "next/navigation";

import { AdminAuthShell } from "@/components/admin/admin-auth-shell";
import { AdminLoginForm } from "@/components/admin/admin-login-form";
import { getDb } from "@/db/client";
import { getAdminSession } from "@/lib/admin/guard";
import { hasAdmin } from "@/lib/admin/setup";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "登录" };

export default async function AdminLoginPage() {
  const config = getConfig();
  const base = `/${config.adminPath}`;
  const db = getDb();

  // Already signed in? Go straight through; there is nothing to do on this page.
  const session = await getAdminSession(db);
  if (session) redirect(base);

  // No administrator exists yet: the only meaningful action is registering the first one.
  if (!(await hasAdmin(db))) redirect(`${base}/setup`);

  return (
    <AdminAuthShell
      title="管理员登录"
      description="使用商城本地管理员账号登录，与论坛账号无关。"
    >
      <AdminLoginForm base={base} />
    </AdminAuthShell>
  );
}
