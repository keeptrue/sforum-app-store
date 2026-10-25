import type { Metadata } from "next";

import { PageHeader } from "@/components/common/page-header";
import { AuditFilterForm } from "@/components/admin/audit-filter-form";
import { AuditPagination, auditHref } from "@/components/admin/audit-pagination";
import {
  AuditEmptyState,
  AuditFailureState,
  AuditNoMatchState,
} from "@/components/admin/audit-states";
import { AuditTable } from "@/components/admin/audit-table";
import { getDb } from "@/db/client";
import {
  auditFilterValues,
  auditFilters,
  decodeAuditCursor,
  hasAuditFilters,
  loadAuditPage,
  parseAuditTrail,
  type AuditPageResult,
} from "@/lib/admin/audit";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "审计日志",
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

/** Last value wins: a repeated param must not turn into a broken filter. */
function param(raw: SearchParams, name: string): string | null {
  const value = raw[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[value.length - 1] ?? null;
  return null;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const base = `/${getConfig().adminPath}`;
  const raw = await searchParams;

  const values = auditFilterValues((name) => param(raw, name));
  const filters = auditFilters(values);
  const filtered = hasAuditFilters(filters);

  // The cursor in flight is the top of the trail; an unreadable one simply means page one.
  const trail = parseAuditTrail(param(raw, "trail"));
  const cursorRaw = trail[trail.length - 1];
  const cursor = cursorRaw === undefined ? null : decodeAuditCursor(cursorRaw);

  let page: AuditPageResult | null = null;
  let failed = false;
  try {
    page = await loadAuditPage(getDb(), { filters, cursor });
  } catch (error) {
    // Log the cause, show a fixed sentence: driver errors can carry the connection string.
    console.error("[admin] audit read failed", error);
    failed = true;
  }

  return (
    <>
      <PageHeader
        title="审计日志"
        description="谁在什么时候对什么做了什么。追加型记录，按 (created_at, id) 游标翻页，后台不提供编辑或删除。"
      />

      <AuditFilterForm base={base} values={values} />

      {failed || page === null ? (
        <AuditFailureState
          reason="这次查询没有跑完，可能是数据库连接中断或迁移未执行。"
          retryHref={auditHref(base, values, trail)}
        />
      ) : page.entries.length === 0 ? (
        filtered ? (
          <AuditNoMatchState base={base} hasFilters />
        ) : (
          <AuditEmptyState />
        )
      ) : (
        <>
          <AuditTable entries={page.entries} />
          <AuditPagination
            base={base}
            values={values}
            trail={trail}
            nextCursor={page.nextCursor}
          />
        </>
      )}
    </>
  );
}
