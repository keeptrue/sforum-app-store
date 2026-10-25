import type { ReactNode } from "react";
import Link from "next/link";
import { Inbox } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  ModerationQueue,
  ModerationQueueProduct,
  ModerationQueueVersion,
} from "@/lib/moderation/types";

import { formatWaiting, kindLabel } from "./format";

/**
 * Left pane of the review console. Two groups because the domain separates the product
 * lifecycle from the release state (plan §5.3): a product waiting for its first approval
 * and a version held after approval are different decisions with different actions.
 *
 * Rows are plain links, so the selection lives in the URL and the detail pane stays a
 * server component. Row hierarchy: name, then machine identity (mono), then who/what;
 * the teal left bar marks the selected row on the accent surface.
 */

export function QueuePanel({
  queue,
  selectedProductId,
  selectedVersionId,
  now,
}: {
  queue: ModerationQueue;
  selectedProductId: string | null;
  selectedVersionId: string | null;
  /** One request-scoped timestamp, so every "waiting" value agrees. */
  now: number;
}) {
  const total = queue.products.length + queue.versions.length;

  return (
    <div className="flex min-h-0 flex-col md:h-full">
      <div className="flex items-baseline justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-xs font-semibold tracking-tight">待审队列</h2>
        <span className="text-[12.5px] tabular-nums text-muted-foreground">
          {total} 项
        </span>
      </div>

      {total === 0 ? (
        <QueueEmpty />
      ) : (
        <div className="scrollbar-thin max-h-[50vh] min-h-0 flex-1 overflow-y-auto md:max-h-none">
          <QueueGroup
            title="待审产品"
            hint="首次上线，或改名、换仓库后重新提交"
            count={queue.products.length}
          >
            {queue.products.map((row) => (
              <ProductRow
                key={row.productId}
                row={row}
                now={now}
                selected={
                  selectedProductId === row.productId && selectedVersionId === null
                }
              />
            ))}
          </QueueGroup>

          <QueueGroup
            title="等审版本"
            hint="产品已上线，但这次版本引入的变化需要人工确认"
            count={queue.versions.length}
          >
            {queue.versions.map((row) => (
              <VersionRow
                key={row.versionId}
                row={row}
                now={now}
                selected={selectedVersionId === row.versionId}
              />
            ))}
          </QueueGroup>
        </div>
      )}
    </div>
  );
}

function QueueGroup({
  title,
  hint,
  count,
  children,
}: {
  title: string;
  hint: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <div className="sticky top-0 z-10 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border bg-card/95 px-4 py-2 backdrop-blur-sm">
        <h3 className="text-[12.5px] font-semibold tracking-tight">{title}</h3>
        <span className="font-display text-[12.5px] font-semibold leading-none tabular-nums text-muted-foreground">
          {count}
        </span>
        <span className="basis-full text-[12px] leading-relaxed text-muted-foreground">
          {hint}
        </span>
      </div>
      {count === 0 ? (
        <p className="px-4 py-3 text-[12.5px] text-muted-foreground">这一类暂时没有待审项。</p>
      ) : (
        <ul className="divide-y divide-border">{children}</ul>
      )}
    </section>
  );
}

function RowShell({
  href,
  selected,
  children,
}: {
  href: string;
  selected: boolean;
  children: ReactNode;
}) {
  return (
    <li>
      <Link
        href={href}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "block border-l-2 px-3.5 py-2.5 transition-colors outline-none focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40",
          selected
            ? "border-l-primary bg-accent"
            : "border-l-transparent hover:bg-muted/60",
        )}
      >
        {children}
      </Link>
    </li>
  );
}

function ProductRow({
  row,
  now,
  selected,
}: {
  row: ModerationQueueProduct;
  now: number;
  selected: boolean;
}) {
  return (
    <RowShell href={`/moderation?product=${row.productId}`} selected={selected}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-xs font-medium text-foreground">
            {row.name}
          </span>
          <Badge variant="outline" className="shrink-0">
            {kindLabel(row.kind)}
          </Badge>
        </span>
        <span className="shrink-0 text-[12.5px] tabular-nums text-muted-foreground">
          {formatWaiting(row.submittedAt, now)}
        </span>
      </div>
      <div className="mt-1 truncate font-mono text-[12.5px] text-muted-foreground">
        {row.extensionId}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px] text-muted-foreground">
        <span className="min-w-0 truncate">{row.submittedBy ?? "提交人未知"}</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">{row.versionCount} 个版本</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">{row.capabilities.length} 项能力</span>
      </div>
    </RowShell>
  );
}

function VersionRow({
  row,
  now,
  selected,
}: {
  row: ModerationQueueVersion;
  now: number;
  selected: boolean;
}) {
  return (
    <RowShell
      href={`/moderation?product=${row.productId}&version=${row.versionId}`}
      selected={selected}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-medium text-foreground">
          {row.productName}
        </span>
        <span className="shrink-0 text-[12.5px] tabular-nums text-muted-foreground">
          {formatWaiting(row.createdAt, now)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 font-mono text-[12.5px]">
        <span className="shrink-0 font-medium text-foreground/80">{row.version}</span>
        {row.channel === "beta" && <Badge variant="secondary">beta</Badge>}
        <span className="min-w-0 truncate text-muted-foreground">{row.extensionId}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground">
        {row.capabilitiesNew.length > 0 && (
          <Badge variant="warning">新增 {row.capabilitiesNew.length} 项能力</Badge>
        )}
        {row.productRenamed && <Badge variant="warning">产品改名</Badge>}
        <span className="tabular-nums">{row.capabilities.length} 项能力</span>
        <span aria-hidden>·</span>
        <span className="font-mono text-[12px]">sforum {row.sforumVersion}</span>
      </div>
    </RowShell>
  );
}

function QueueEmpty() {
  return (
    <div className="px-4 py-10 text-center">
      <div className="mx-auto grid size-8 place-items-center rounded-md bg-secondary">
        <Inbox className="size-4 text-muted-foreground" aria-hidden />
      </div>
      <p className="mt-2 text-xs font-medium">没有待审项</p>
      <p className="mx-auto mt-1 max-w-[34ch] text-[13px] leading-relaxed text-muted-foreground">
        队列是空的。新产品首次提交、新版本声明了没审过的能力，或产品改名、换仓库之后，会重新出现在这里。
      </p>
    </div>
  );
}
