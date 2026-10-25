import { ArrowRight } from "lucide-react";

import type { ModerationEvent } from "@/lib/moderation/types";

import { eventActionLabel, formatAgo, stateLabel } from "./format";

/**
 * Audit trail for this subject. `actor === null` is the sync worker, printed as 「系统」;
 * a reason is shown verbatim because that is what the developer was told.
 * Timestamps stay mono (machine time); state labels are prose, so they are not.
 */
export function EventTimeline({
  events,
  now,
}: {
  events: ModerationEvent[];
  now: number;
}) {
  if (events.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[12.5px] text-muted-foreground">
        还没有审核事件。提交、批准、拒绝、自动发布与下架都会记在这里。
      </p>
    );
  }

  return (
    <ol className="border-l border-border">
      {events.map((event) => (
        <li key={event.id} className="relative pb-3 pl-4 last:pb-0">
          <span
            aria-hidden
            className="absolute left-0 top-[7px] size-1.5 -translate-x-1/2 rounded-full bg-foreground/25"
          />
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[12.5px] font-medium text-foreground">
              {eventActionLabel(event.action)}
            </span>
            <Transition from={event.fromState} to={event.toState} />
            <span
              className="ml-auto font-mono text-[12px] tabular-nums text-muted-foreground"
              title={event.createdAt}
            >
              {formatAgo(event.createdAt, now)}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px] text-muted-foreground">
            <span>{event.actor ?? "系统"}</span>
            {event.reason ? (
              <span className="min-w-0 leading-relaxed">理由：{event.reason}</span>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Transition({ from, to }: { from: string | null; to: string | null }) {
  const fromLabel = stateLabel(from);
  const toLabel = stateLabel(to);
  if (!fromLabel && !toLabel) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
      {fromLabel ? <span>{fromLabel}</span> : null}
      {fromLabel && toLabel ? <ArrowRight className="size-3" aria-hidden /> : null}
      {toLabel ? <span>{toLabel}</span> : null}
    </span>
  );
}
