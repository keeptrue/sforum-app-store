import { PageHeader } from "@/components/common/page-header";
import { AdminAccountsTable } from "@/components/admin/admin-accounts-table";
import { CreateAdminDialog } from "@/components/admin/create-admin-dialog";
import { ForumAccountsTable } from "@/components/admin/forum-accounts-table";
import { getDb } from "@/db/client";
import { listAdmins, listForumAccounts } from "@/lib/admin/accounts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "账号与角色" };

/**
 * Two populations, two blocks — they are not the same thing and the page must not blur them:
 * administrators are store-local (password), forum accounts are OAuth identities that can be
 * given the `moderator` role.
 */
export default async function AdminAccountsPage() {
  const db = getDb();
  const [admins, forum] = await Promise.all([listAdmins(db), listForumAccounts(db, {})]);

  return (
    <>
      <PageHeader
        title="账号与角色"
        description="管理员是商城本地账号（密码登录）；论坛账号来自 OAuth2，只能授予审核员。"
        actions={<CreateAdminDialog />}
      />

      <section aria-labelledby="admins-heading" className="mb-10">
        <h2 id="admins-heading" className="font-display mb-2 text-sm font-semibold">
          管理员 · {admins.length}
        </h2>
        <AdminAccountsTable admins={admins} />
      </section>

      <section aria-labelledby="forum-heading">
        <h2 id="forum-heading" className="font-display mb-2 text-sm font-semibold">
          论坛账号
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          审核员能进 <code className="font-mono">/moderation</code> 处理队列；后台入口只对管理员开放。
        </p>
        <ForumAccountsTable initialRows={forum.rows} initialTotal={forum.total} />
      </section>
    </>
  );
}
