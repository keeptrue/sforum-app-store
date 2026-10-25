import { AlertTriangle, ShieldCheck, UserCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { PolicyOutcome, PolicyRule } from "@/lib/admin/policy";

/**
 * One rule group. The outcome is not written by hand here — `policy.ts` derives it by calling
 * `decideReleaseState` for each reason, so this component only decides how it looks.
 */

const OUTCOME_COPY: Record<
  PolicyOutcome,
  { label: string; icon: typeof ShieldCheck; variant: "success" | "warning" }
> = {
  published: { label: "自动发布", icon: ShieldCheck, variant: "success" },
  pending_review: { label: "退回人工", icon: UserCheck, variant: "warning" },
};

export function PolicyRuleList({
  title,
  outcome,
  rules,
}: {
  title: string;
  outcome: PolicyOutcome;
  rules: PolicyRule[];
}) {
  const copy = OUTCOME_COPY[outcome];
  const Icon = copy.icon;

  return (
    <section aria-labelledby={`policy-${outcome}-heading`}>
      <div className="mb-2 flex items-center gap-2">
        <Icon aria-hidden className="size-4 text-muted-foreground" />
        <h2 id={`policy-${outcome}-heading`} className="font-display text-sm font-semibold">
          {title}
        </h2>
        <Badge variant={copy.variant}>{copy.label}</Badge>
        <span className="text-[12.5px] text-muted-foreground">{rules.length} 条</span>
      </div>

      <ul className="divide-y divide-border surface">
        {rules.map((rule) => (
          <li key={rule.reason} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-sm font-medium">{rule.title}</span>
              <span className="font-mono text-[12.5px] text-muted-foreground">{rule.reason}</span>
            </div>
            <p className="mt-1 max-w-[78ch] text-xs leading-relaxed text-muted-foreground">
              {rule.detail}
            </p>
            {rule.consistent ? null : (
              <p className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-warning">
                <AlertTriangle aria-hidden className="size-3" />
                这条判定已经不再由 <span className="font-mono">{rule.reason}</span> 触发，规则改过，文案待更新。
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
