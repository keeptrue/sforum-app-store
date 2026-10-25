import { redirect } from "next/navigation";

import { AdminAuthShell } from "@/components/admin/admin-auth-shell";
import { AdminPasswordForm } from "@/components/admin/admin-password-form";
import { getDb } from "@/db/client";
import { getAdminSession } from "@/lib/admin/guard";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "修改密码" };

export default async function AdminPasswordPage() {
  const config = getConfig();
  const base = `/${config.adminPath}`;
  const session = await getAdminSession(getDb());

  if (!session) redirect(`${base}/login`);

  return (
    <AdminAuthShell
      title={session.admin.mustChangePassword ? "先设置新密码" : "修改密码"}
      description={
        session.admin.mustChangePassword
          ? "当前密码由其他管理员设置，修改后才能进入后台。"
          : "修改后其它设备上的会话仍然有效，需要的话去「账号与角色」里强制下线。"
      }
    >
      <AdminPasswordForm base={base} />
    </AdminAuthShell>
  );
}
