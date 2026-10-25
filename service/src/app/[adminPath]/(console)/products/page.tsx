import { PageHeader } from "@/components/common/page-header";
import { AdminProductsTable } from "@/components/admin/admin-products-table";
import { getDb } from "@/db/client";
import { listProductsForAdmin } from "@/lib/admin/products";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "全局产品" };

/**
 * Every product on the store, across owners. The dashboard list is owner-scoped by design;
 * this one is the operator's view and carries the two incident actions.
 */
export default async function AdminProductsPage() {
  const db = getDb();
  const { rows, total } = await listProductsForAdmin(db, {});

  return (
    <>
      <PageHeader
        title="全局产品"
        description="跨开发者查看全站产品。强制下架与撤回版本都会写审计，并立即影响下载。"
      />
      <AdminProductsTable initialRows={rows} initialTotal={total} />
    </>
  );
}
