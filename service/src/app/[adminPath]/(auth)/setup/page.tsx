import { notFound, redirect } from "next/navigation";

import { AdminAuthShell } from "@/components/admin/admin-auth-shell";
import { AdminSetupForm } from "@/components/admin/admin-setup-form";
import { getDb } from "@/db/client";
import { getAdminSession } from "@/lib/admin/guard";
import { hasAdmin } from "@/lib/admin/setup";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "初始化管理员" };

/**
 * Registration exists only while the store has no administrator. Once one exists the route
 * is gone (404), so a leaked URL cannot be used to add a second, uninvited admin.
 */
export default async function AdminSetupPage() {
  const config = getConfig();
  const base = `/${config.adminPath}`;
  const db = getDb();

  if (await hasAdmin(db)) notFound();

  const session = await getAdminSession(db);
  if (session) redirect(base);

  // Without the token the route is closed rather than open to whoever arrives first. Show the
  // command instead of a form that would always fail.
  if (!config.adminSetupToken) {
    return (
      <AdminAuthShell
        title="注册入口未开启"
        description="服务端没有配置 STORE_ADMIN_SETUP_TOKEN，首个管理员无法通过网页创建。"
        footer="生成后写入环境变量并重启服务：openssl rand -base64 32"
      >
        <pre className="overflow-x-auto rounded-md border border-border bg-evidence px-3 py-2 font-mono text-xs text-evidence-foreground">
          STORE_ADMIN_SETUP_TOKEN=&lt;32 位以上随机串&gt;
        </pre>
      </AdminAuthShell>
    );
  }

  return (
    <AdminAuthShell
      title="创建首个管理员"
      description="商城还没有管理员。填入 setup token 完成初始化，之后这个入口会永久关闭。"
    >
      <AdminSetupForm base={base} />
    </AdminAuthShell>
  );
}
