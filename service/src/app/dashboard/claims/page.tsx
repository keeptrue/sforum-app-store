import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { PageHeader } from "@/components/common/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ClaimButton } from "@/components/dashboard/claim-button";
import { formatDateTime } from "@/components/dashboard/labels";
import { requireDashboardSession } from "@/components/dashboard/session";
import { getDb } from "@/db/client";
import { listPendingClaims } from "@/lib/github/claims";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "待认领的 release" };

/**
 * Releases waiting for an owner.
 *
 * Sync no longer creates a product on its own, so a repository publishing an unknown
 * `extension_id` leaves a proposal here instead of silently becoming someone's product.
 * Only claims behind the account's own active installations are listed.
 */
export default async function ClaimsPage() {
  const session = await requireDashboardSession();
  const claims = await listPendingClaims(getDb(), session.account.id);

  return (
    <div className="mx-auto w-full max-w-[1280px] px-5 pb-16 pt-7">
      <PageHeader
        eyebrow="开发者门户"
        title="待认领的 release"
        description="这些 release 里的扩展 ID 还没有对应产品。认领会重新读取 release 里的清单，用它的 ID、名称和类型建产品，并同步这个版本。"
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link href="/dashboard">
              <ArrowLeft aria-hidden />
              我的产品
            </Link>
          </Button>
        }
        meta={<span>{claims.length} 条待处理</span>}
      />

      <div className="pt-5">
        {claims.length === 0 ? (
          <section className="surface px-5 py-6">
            <h2 className="text-sm font-semibold">没有待认领的 release</h2>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              仓库发布 release 时，如果清单里的扩展 ID 还没有对应产品，这里会出现一条记录。
              你也可以直接在产品页绑定仓库，让后续 release 直接同步。
            </p>
          </section>
        ) : (
          <ul className="grid gap-2">
            {claims.map((claim) => (
              <li key={claim.id} className="surface">
                <div className="flex flex-wrap items-start justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs break-all">
                        {claim.extensionId}
                      </span>
                      {claim.tag ? (
                        <Badge variant="outline">{claim.tag}</Badge>
                      ) : null}
                      <Badge variant="warning">待认领</Badge>
                    </div>
                    <p className="mt-1 text-[12.5px] break-all text-muted-foreground">
                      来自 <span className="font-mono">{claim.repoFullName}</span>
                      （安装账号 <span className="font-mono">{claim.accountLogin}</span>）
                    </p>
                    <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                      {claim.manifestName ? `${claim.manifestName} · ` : null}
                      最近一次更新 {formatDateTime(claim.updatedAt)}
                    </p>
                  </div>
                  <ClaimButton claimId={claim.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
