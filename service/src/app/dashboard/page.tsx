import Link from "next/link";
import { GitBranch, Inbox, PackagePlus, Send } from "lucide-react";

import { PageHeader } from "@/components/common/page-header";
import { Stat } from "@/components/common/stat";
import { ImportProductDialog } from "@/components/dashboard/import-product-dialog";
import { ProductList, type ProductRow } from "@/components/dashboard/product-list";
import {
  requireDashboardSession,
  sessionIdentity,
} from "@/components/dashboard/session";
import { getDb } from "@/db/client";
import { listPendingClaims } from "@/lib/github/claims";
import { listDashboardProductRows } from "@/lib/products/service";

// Products, versions and review state are all runtime facts: every request reads Postgres.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "开发者门户" };

export default async function DashboardPage() {
  const session = await requireDashboardSession();
  const db = getDb();
  const accountId = session.account.id;

  // "Latest version" and the version count of every row come from one owner-scoped
  // aggregate (`listProductVersionSummaries`): the page reads Postgres a fixed number of
  // times, independent of how many products the account owns.
  const rows: ProductRow[] = await listDashboardProductRows(db, accountId);
  // Claims are the "a release is waiting for an owner" signal; the count is cheap and the
  // callout is the only place the developer learns the queue exists.
  const claims = await listPendingClaims(db, accountId);

  const published = rows.filter((row) => row.product.status === "published").length;
  const reviewing = rows.filter(
    (row) => row.product.status === "pending_review",
  ).length;
  const editable = rows.filter(
    (row) => row.product.status === "draft" || row.product.status === "rejected",
  ).length;

  return (
    <div className="mx-auto w-full max-w-[1280px] px-5 pb-16 pt-7">
      <PageHeader
        title="我的产品"
        description="这里只管理属于当前账号的产品：文案、README 与版本都在对应产品页操作。别人的产品一律按 404 处理，不泄漏存在性。"
        meta={<span className="font-mono break-all">{sessionIdentity(session)}</span>}
        actions={
          <>
            {[
              [published, "已发布"],
              [reviewing, "待审核"],
              [editable, "草稿/被拒"],
            ].map(([value, label]) => (
              <Stat
                key={String(label)}
                variant="bare"
                label={label}
                value={value}
              />
            ))}
            <ImportProductDialog />
          </>
        }
      />

      {claims.length > 0 ? (
        <div className="pt-5">
          <Link
            href="/dashboard/claims"
            className="surface flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="grid size-6 shrink-0 place-items-center rounded-md bg-evidence text-evidence-foreground">
                <Inbox className="size-3.5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-semibold">
                  有 {claims.length} 条 release 等待认领
                </span>
                <span className="mt-0.5 block text-[13px] leading-relaxed text-muted-foreground">
                  这些 release 里的扩展 ID 还没有对应产品。认领会用清单里的 ID 建产品并绑定仓库。
                </span>
              </span>
            </span>
            <span className="shrink-0 text-[12.5px] text-muted-foreground">去处理</span>
          </Link>
        </div>
      ) : null}

      <div className="pt-5">
        {rows.length === 0 ? (
          <section className="surface">
            <div className="px-5 py-4">
              <h2 className="text-sm font-semibold">从 GitHub 导入第一个产品</h2>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                产品身份来自仓库：清单给出扩展 ID 与名称，README 给出介绍，release
                给出可安装的版本。商城不接受手工创建，也不存包体。
              </p>
            </div>
            <ol className="grid border-t border-border sm:grid-cols-3">
              <li className="flex flex-col gap-2.5 border-b border-border p-4 sm:border-b-0 sm:border-r">
                <div className="flex items-center gap-2">
                  <span className="grid size-6 shrink-0 place-items-center rounded-md bg-evidence text-evidence-foreground">
                    <GitBranch className="size-3.5" aria-hidden />
                  </span>
                  <span className="font-display text-xs font-semibold tabular-nums text-muted-foreground">
                    01
                  </span>
                  <span className="text-xs font-semibold">从 GitHub 导入</span>
                </div>
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  点右上角「从仓库导入」，选一个已装 GitHub App 的仓库；清单里的{" "}
                  <span className="font-mono">id</span> 与名称直接成为产品身份。
                </p>
              </li>
              <li className="flex flex-col gap-2.5 border-b border-border p-4 sm:border-b-0 sm:border-r sm:last:border-r-0">
                <div className="flex items-center gap-2">
                  <span className="grid size-6 shrink-0 place-items-center rounded-md bg-evidence text-evidence-foreground">
                    <PackagePlus className="size-3.5" aria-hidden />
                  </span>
                  <span className="font-display text-xs font-semibold tabular-nums text-muted-foreground">
                    02
                  </span>
                  <span className="text-xs font-semibold">推送 release</span>
                </div>
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  在仓库里发一个带 ZIP 与{" "}
                  <span className="font-mono">sforum.extension.json</span> 的 release，
                  商城会同步这个版本并读出 README。
                </p>
              </li>
              <li className="flex flex-col gap-2.5 p-4">
                <div className="flex items-center gap-2">
                  <span className="grid size-6 shrink-0 place-items-center rounded-md bg-evidence text-evidence-foreground">
                    <Send className="size-3.5" aria-hidden />
                  </span>
                  <span className="font-display text-xs font-semibold tabular-nums text-muted-foreground">
                    03
                  </span>
                  <span className="text-xs font-semibold">写摘要并提交审核</span>
                </div>
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  介绍已经在 README 里了，补一句摘要、选好分类与标签，再点「提交审核」。
                </p>
              </li>
            </ol>
          </section>
        ) : (
          <ProductList rows={rows} />
        )}
      </div>
    </div>
  );
}
