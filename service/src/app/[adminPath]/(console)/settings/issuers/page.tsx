import { PageHeader } from "@/components/common/page-header";
import { IssuerGuide } from "@/components/admin/issuer-guide";
import { IssuersTable } from "@/components/admin/issuers-table";
import { getDb } from "@/db/client";
import { listIssuers } from "@/lib/admin/issuers";
import { getRuntimeConfig } from "@/lib/settings/runtime";
import { sforumCallbackUrl } from "@/lib/oauth/redirect";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "OAuth2 配置" };

/**
 * OAuth2 providers. This page is the only writer — `STORE_BOOTSTRAP_ISSUER` no longer exists
 * (decisions/2026-10-25-admin-local-identity.md), so a fresh deployment starts with zero
 * issuers and forum login stays closed until one is added here.
 *
 * One deployment serves one forum: at most one issuer may be active
 * (decisions/2026-10-24-app-store-identity-and-distribution.md §身份). The callback URI is
 * derived from `STORE_PUBLIC_URL` here and in the login route from the same helper, so the
 * string people copy into SForum cannot drift from the one the store actually sends.
 */
export default async function AdminIssuersPage() {
  const db = getDb();
  const issuers = await listIssuers(db);
  const callbackUrl = sforumCallbackUrl((await getRuntimeConfig(db)).publicUrl);
  const hasActive = issuers.some((issuer) => issuer.status === "active");

  return (
    <>
      <PageHeader
        title="OAuth2 配置"
        description="论坛用户通过这些 issuer 登录开发者门户。一个商城只接入一个论坛：启用中的 issuer 只能有一个，停用只关闭登录、保留历史账号与商品归属。密钥加密存储，保存后不再显示。"
      />
      <IssuerGuide callbackUrl={callbackUrl} defaultOpen={!hasActive} />
      <IssuersTable
        issuers={issuers}
        callbackUrl={callbackUrl}
        hasActive={hasActive}
      />
    </>
  );
}
