import Link from "next/link";
import { FileClock, RefreshCw, SearchX } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * The three states the trail can be in. Kept apart from the table so "empty because the store
 * is new", "empty because the filter is too narrow" and "the read failed" never collapse into
 * one grey box — each needs a different next action from the operator.
 */

export function AuditEmptyState() {
  return (
    <div className="surface px-6 py-12 text-center">
      <FileClock aria-hidden className="mx-auto size-5 text-muted-foreground" />
      <p className="mt-3 text-sm font-medium">还没有任何审计记录</p>
      <p className="mx-auto mt-1 max-w-[46ch] text-xs leading-relaxed text-muted-foreground">
        管理员登录、账号与角色变更、产品审核、发布与下架都会追加到这里。第一条记录通常在首个管理员注册时产生。
      </p>
    </div>
  );
}

export function AuditNoMatchState({
  base,
  hasFilters,
}: {
  base: string;
  hasFilters: boolean;
}) {
  return (
    <div className="surface px-6 py-12 text-center">
      <SearchX aria-hidden className="mx-auto size-5 text-muted-foreground" />
      <p className="mt-3 text-sm font-medium">
        {hasFilters ? "没有符合筛选条件的记录" : "这一页没有记录"}
      </p>
      <p className="mx-auto mt-1 max-w-[46ch] text-xs leading-relaxed text-muted-foreground">
        {hasFilters
          ? "换个动作片段、放宽时间范围，或者清掉筛选从最新一页重新看。"
          : "游标已经走到末尾，回到第一页重新开始。"}
      </p>
      <div className="mt-4 flex justify-center">
        <Button asChild variant="outline" size="sm">
          <Link href={`${base}/audit`}>回到第一页</Link>
        </Button>
      </div>
    </div>
  );
}

export function AuditFailureState({
  reason,
  retryHref,
}: {
  reason: string;
  /** The current URL, so a retry re-runs the same query instead of dropping the filters. */
  retryHref: string;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive/5 px-6 py-10 text-center"
    >
      <RefreshCw aria-hidden className="mx-auto size-5 text-destructive" />
      <p className="mt-3 text-sm font-medium">读取审计日志失败</p>
      <p className="mx-auto mt-1 max-w-[52ch] text-xs leading-relaxed text-muted-foreground">
        {reason}
      </p>
      <p className="mx-auto mt-1 max-w-[52ch] text-xs leading-relaxed text-muted-foreground">
        数据库不可达时整页都无法读取；先看「系统健康」，再重试。
      </p>
      <div className="mt-4 flex justify-center">
        {/* A plain anchor: a retry must re-run the server render, not replay a cached RSC payload. */}
        <Button asChild variant="outline" size="sm">
          <a href={retryHref}>重试</a>
        </Button>
      </div>
    </div>
  );
}
