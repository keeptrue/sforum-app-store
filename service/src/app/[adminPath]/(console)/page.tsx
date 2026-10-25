import Link from "next/link";

import { PageHeader } from "@/components/common/page-header";
import { StatGrid } from "@/components/common/stat";
import { getDb } from "@/db/client";
import { loadOverview } from "@/lib/admin/overview";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "概览" };

export default async function AdminOverviewPage() {
  const config = getConfig();
  const base = `/${config.adminPath}`;
  const db = getDb();
  const { counts, recentLogins, issuers } = await loadOverview(db);

  return (
    <>
      <PageHeader
        title="概览"
        description="商城的运行面：谁在管理、有多少产品在流转、登录方式是否配好。"
      />

      <section aria-labelledby="counts-heading" className="mb-8">
        <h2 id="counts-heading" className="sr-only">
          计数
        </h2>
        <StatGrid
          items={[
            {
              label: "待审产品",
              value: counts.pendingProducts,
              hint: counts.pendingProducts > 0 ? "需要人工裁决" : "队列为空",
            },
            {
              label: "待审版本",
              value: counts.pendingVersions,
              hint: counts.pendingVersions > 0 ? "candidate / pending_review" : "无",
            },
            {
              label: "已发布产品",
              value: counts.published,
              hint: `共 ${counts.products} 个产品 / ${counts.versions} 个版本`,
            },
            {
              label: "活跃登录方式",
              value: counts.activeIssuers,
              hint:
                counts.activeIssuers === 0
                  ? "尚未配置，论坛用户无法登录"
                  : `共 ${counts.issuers} 个 issuer`,
            },
          ]}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="admins-heading">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h2 id="admins-heading" className="font-display text-sm font-semibold">
              管理员
            </h2>
            <Link href={`${base}/accounts`} className="text-xs text-muted-foreground hover:text-foreground">
              管理账号
            </Link>
          </div>
          <div className="surface">
            <dl className="grid grid-cols-2 gap-px bg-border text-sm">
              <div className="bg-card px-4 py-3">
                <dt className="text-xs text-muted-foreground">启用</dt>
                <dd className="font-display mt-0.5 text-lg tabular-nums">
                  {counts.admins - counts.adminsDisabled}
                </dd>
              </div>
              <div className="bg-card px-4 py-3">
                <dt className="text-xs text-muted-foreground">已禁用</dt>
                <dd className="font-display mt-0.5 text-lg tabular-nums">
                  {counts.adminsDisabled}
                </dd>
              </div>
            </dl>
            <ul className="divide-y divide-border border-t border-border">
              {recentLogins.length === 0 ? (
                <li className="px-4 py-3 text-sm text-muted-foreground">还没有登录记录</li>
              ) : (
                recentLogins.map((admin) => (
                  <li
                    key={admin.username}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                  >
                    <span className="truncate">{admin.username}</span>
                    <span className="font-mono text-[12.5px] text-muted-foreground">
                      {admin.lastLoginAt
                        ? admin.lastLoginAt.toISOString().replace("T", " ").slice(0, 16)
                        : "从未登录"}
                    </span>
                  </li>
                ))
              )}
            </ul>
          </div>
        </section>

        <section aria-labelledby="issuers-heading">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h2 id="issuers-heading" className="font-display text-sm font-semibold">
              登录方式
            </h2>
            <Link
              href={`${base}/settings/issuers`}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              配置 OAuth2
            </Link>
          </div>
          <div className="surface">
            {issuers.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                还没有配置任何 OAuth2 issuer。论坛用户此刻无法登录开发者门户。
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {issuers.map((issuer) => (
                  <li
                    key={issuer.issuerKey}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                  >
                    <span className="min-w-0">
                      <span className="truncate">{issuer.displayName}</span>
                      <span className="ml-2 font-mono text-[12.5px] text-muted-foreground">
                        {issuer.issuerKey}
                      </span>
                    </span>
                    <span
                      className={
                        issuer.status === "active"
                          ? "shrink-0 rounded-full border border-border px-2 py-0.5 text-[12.5px]"
                          : "shrink-0 rounded-full border border-border px-2 py-0.5 text-[12.5px] text-muted-foreground"
                      }
                    >
                      {issuer.status === "active" ? "启用" : "已停用"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
