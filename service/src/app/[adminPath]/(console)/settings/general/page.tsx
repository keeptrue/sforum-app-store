import { headers } from "next/headers";

import { PageHeader } from "@/components/common/page-header";
import { StoreSettingsForm } from "@/components/admin/store-settings-form";
import { getDb } from "@/db/client";
import { getStoreSettingsView } from "@/lib/settings/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "系统设置", robots: { index: false, follow: false } };

/**
 * Runtime configuration (2026-10-25).
 *
 * These keys used to be env-only, which meant changing the address visitors use — or
 * tightening a rate limit during an attack — needed a redeploy and a restart of every process.
 * They now live in `store_settings`; a save is in effect on the next request in this process.
 *
 * The page reports where each value comes from (database / env seed / built-in) and compares
 * the effective public URL with the host this request arrived on. That comparison is the
 * cheapest detector for the classic "login does nothing" misconfiguration, so it is shown
 * here rather than buried in `/api/health`.
 */
export default async function StoreSettingsPage() {
  const db = getDb();
  const headerList = await headers();
  const requestHost =
    headerList.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    headerList.get("host")?.trim() ||
    null;

  const settings = await getStoreSettingsView(db, { requestHost });

  return (
    <>
      <PageHeader
        title="系统设置"
        description="对外地址、下载链接有效期与限流。保存后当前进程下一个请求即生效；机密（会话密钥、下载签名密钥、加密 keyring）不在这里，它们只能来自环境变量。"
      />
      <StoreSettingsForm view={settings} />
    </>
  );
}
