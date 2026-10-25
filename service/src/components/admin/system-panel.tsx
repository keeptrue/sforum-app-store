import { CircleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { HealthSummary, HealthTone } from "@/lib/admin/system";
import { cn } from "@/lib/utils";

/**
 * Shared shell for the health panels.
 *
 * Every panel is fed a `Section<T>` from the loader, so "this block failed" is a rendering
 * branch rather than an error boundary: one dead subsystem must leave the other five legible.
 */

const TONE_BADGE: Record<HealthTone, { variant: "success" | "warning" | "destructive"; label: string }> = {
  ok: { variant: "success", label: "正常" },
  warn: { variant: "warning", label: "需要注意" },
  error: { variant: "destructive", label: "异常" },
};

export function SystemSummaryBar({
  summary,
  generatedAt,
  failures,
}: {
  summary: HealthSummary;
  generatedAt: string;
  failures: string[];
}) {
  const tone = TONE_BADGE[summary.tone];
  return (
    <div
      className={cn(
        "mb-6 rounded-lg border bg-card px-4 py-3",
        summary.tone === "error" ? "border-destructive/40" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={tone.variant}>{tone.label}</Badge>
        <p className="min-w-0 text-sm">{summary.text}</p>
      </div>
      <p className="mt-1.5 font-mono text-[12.5px] text-muted-foreground">
        采集于 {generatedAt.replace("T", " ").slice(0, 19)} UTC
      </p>
      {failures.length > 0 ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-warning">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            {failures.join(" / ")} 读取失败，其余面板照常显示。
          </span>
        </p>
      ) : null}
    </div>
  );
}

export function SystemPanel({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="flex min-w-0 flex-col surface"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
        <h2 id={`${id}-heading`} className="font-display text-sm font-semibold">
          {title}
        </h2>
        {hint ? (
          <span className="text-[12.5px] text-muted-foreground">{hint}</span>
        ) : null}
      </div>
      <div className="min-w-0 flex-1 p-4">{children}</div>
    </section>
  );
}

/** One failed block: say which read failed, keep the reason short and credential-free. */
export function PanelError({ label, message }: { label: string; message: string }) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
      <p className="flex items-start gap-1.5 text-sm text-destructive">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
          读取失败：
          <span className="font-mono text-xs break-all">{message}</span>
        </span>
      </p>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        {label}不可读，其它面板不受影响。
      </p>
    </div>
  );
}

export function Metric({
  label,
  value,
  hint,
  mono,
}: {
  label: string;
  value: string | number;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 truncate text-lg tabular-nums",
          mono ? "font-mono text-sm" : "font-display",
        )}
      >
        {value}
      </dd>
      {hint ? <p className="mt-0.5 text-[12.5px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
