import type { ReactNode } from "react";
import { Check } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  CAPABILITY_RISK_BADGE,
  CAPABILITY_RISK_LABELS,
  capabilityEntry,
  describeCapabilities,
  summarizeCapabilities,
} from "@/lib/capabilities/catalog";
import type { DashboardVersion } from "@/lib/products/types";

import { diffCapabilities } from "./format";

/**
 * The reason a version is held: the approved snapshot next to what this version actually
 * declares. Keys that were never approved are called out one by one — the release gate has
 * no risk levels, so every new key re-opens review (plan §7.4 item 13).
 *
 * The tier shown next to each key is the host's, copied from the vendored capability catalog.
 * It orders the moderator's attention; it never admits a key the gate would have held.
 *
 * A product that has never been approved has no snapshot yet; its keys are "unreviewed",
 * not "new", and saying "新增" there would invent a previous approval.
 */
export function CapabilityDiff({
  version,
  approved,
  firstReview,
}: {
  version: DashboardVersion | null;
  approved: string[];
  firstReview: boolean;
}) {
  const current = version?.capabilities ?? [];
  const diff = diffCapabilities(approved, current);
  const pendingKeys = firstReview ? current : diff.added;
  const pendingSummary = summarizeCapabilities(describeCapabilities(pendingKeys));
  const pendingRiskNote =
    pendingSummary.byRisk.high > 0
      ? `，其中 ${pendingSummary.byRisk.high} 项高风险`
      : pendingSummary.byRisk.medium > 0
        ? `，其中 ${pendingSummary.byRisk.medium} 项中风险`
        : "";
  // Both columns use the host's order (high risk first) so the same key sits on the same
  // line in either column and the dangerous rows are the ones a moderator reads first.
  const orderedApproved = describeCapabilities(approved).map((entry) => entry.key);
  const orderedCurrent = describeCapabilities(current).map((entry) => entry.key);

  return (
    <div className="space-y-2.5">
      <div className="grid gap-2.5 md:grid-cols-2">
        <CapabilityColumn
          title="已审快照"
          subtitle={
            firstReview ? "首次审核，尚无快照" : `${approved.length} 项在通过时被接受`
          }
          count={approved.length}
          entries={orderedApproved.map((key) => ({
            key,
            note: diff.removed.includes(key) ? "本版本未声明" : null,
          }))}
          empty="还没有快照。首次审核通过时写入当时的能力集合。"
        />
        <CapabilityColumn
          title={
            version ? (
              <>
                本版本{" "}
                <span className="font-mono text-foreground/80">{version.version}</span>
              </>
            ) : (
              "本版本"
            )
          }
          subtitle={
            pendingKeys.length > 0
              ? `${pendingKeys.length} 项需要人工确认`
              : "与已审快照一致"
          }
          count={current.length}
          entries={orderedCurrent.map((key) => ({
            key,
            note: pendingKeys.includes(key) ? (firstReview ? "待审" : "新增") : null,
          }))}
          empty="这个版本没有声明额外能力。"
        />
      </div>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {pendingKeys.length > 0
          ? `未审 ${pendingKeys.length} 项${pendingRiskNote}——未审过的能力键是这次版本被留下的原因。`
          : "本版本没有未审过的能力键。"}
        通过后会并入已审快照；已审但本次没有声明的键只做记录，不阻塞批准。等级取自宿主能力目录，只用于排优先级。
      </p>
    </div>
  );
}

type CapabilityEntry = { key: string; note: string | null };

function CapabilityColumn({
  title,
  subtitle,
  count,
  entries,
  empty,
}: {
  title: ReactNode;
  subtitle: string;
  count: number;
  entries: CapabilityEntry[];
  empty: string;
}) {
  return (
    <div className="min-w-0 overflow-hidden surface">
      <div className="flex items-start justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium text-foreground">{title}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
            {subtitle}
          </div>
        </div>
        <span className="font-display text-sm font-semibold leading-none tabular-nums text-foreground/80">
          {count}
        </span>
      </div>
      {entries.length === 0 ? (
        <p className="px-3 py-3 text-[13px] leading-relaxed text-muted-foreground">
          {empty}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {entries.map((entry) => {
            const described = capabilityEntry(entry.key);
            return (
              <li key={entry.key} className="px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[12.5px]"
                    title={entry.key}
                  >
                    {entry.key}
                  </span>
                  {entry.note ? (
                    <Badge
                      variant={
                        entry.note === "新增" || entry.note === "待审" ? "warning" : "muted"
                      }
                    >
                      {entry.note}
                    </Badge>
                  ) : (
                    <>
                      <Check className="size-3 shrink-0 text-success" aria-hidden />
                      <span className="sr-only">已审</span>
                    </>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <Badge
                    variant={described.risk ? CAPABILITY_RISK_BADGE[described.risk] : "muted"}
                  >
                    {described.risk ? CAPABILITY_RISK_LABELS[described.risk] : "未收录"}
                  </Badge>
                  <span className="min-w-0 truncate text-[12px] text-muted-foreground">
                    {described.labelZh ?? "宿主目录暂无此键的释义"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
