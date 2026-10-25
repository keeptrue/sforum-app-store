import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AUDIT_PAGE_SIZE, type AuditFilterValues } from "@/lib/admin/audit";

/**
 * Cursor paging for the trail.
 *
 * Keyset order has no "previous page" from a single cursor, so the page carries the stack of
 * cursors it already walked (`?trail=c1,c2`). Forward appends, back drops the last one — no
 * offsets, so a row landing mid-investigation can never shift a page under the operator.
 */

export function auditHref(
  base: string,
  values: AuditFilterValues,
  trail: string[],
): string {
  const params = new URLSearchParams();
  if (values.actor !== "") params.set("actor", values.actor);
  if (values.action !== "") params.set("action", values.action);
  if (values.targetType !== "") params.set("targetType", values.targetType);
  if (values.from !== "") params.set("from", values.from);
  if (values.to !== "") params.set("to", values.to);
  if (trail.length > 0) params.set("trail", trail.join(","));

  const query = params.toString();
  return query === "" ? `${base}/audit` : `${base}/audit?${query}`;
}

export function AuditPagination({
  base,
  values,
  trail,
  nextCursor,
}: {
  base: string;
  values: AuditFilterValues;
  trail: string[];
  nextCursor: string | null;
}) {
  const page = trail.length + 1;
  const previousTrail = trail.slice(0, -1);

  return (
    <nav
      aria-label="审计日志翻页"
      className="mt-3 flex flex-wrap items-center justify-between gap-2"
    >
      <p className="text-[12.5px] text-muted-foreground">
        第 {page} 页 · 每页 {AUDIT_PAGE_SIZE} 条 · 按时间倒序
      </p>
      <div className="flex items-center gap-2">
        {trail.length > 0 ? (
          <Button asChild variant="outline" size="sm">
            <Link href={auditHref(base, values, previousTrail)}>
              <ChevronLeft aria-hidden />
              上一页
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            <ChevronLeft aria-hidden />
            上一页
          </Button>
        )}
        {nextCursor === null ? (
          <Button variant="outline" size="sm" disabled>
            下一页
            <ChevronRight aria-hidden />
          </Button>
        ) : (
          <Button asChild variant="outline" size="sm">
            <Link href={auditHref(base, values, [...trail, nextCursor])}>
              下一页
              <ChevronRight aria-hidden />
            </Link>
          </Button>
        )}
      </div>
    </nav>
  );
}
