import type { Metadata } from "next";
import { Lock } from "lucide-react";

import { PageHeader } from "@/components/common/page-header";
import { PolicyRecentTable } from "@/components/admin/policy-recent-table";
import { PolicyRuleList } from "@/components/admin/policy-rule-list";
import { getDb } from "@/db/client";
import {
  loadRecentDecisions,
  POLICY_RULES,
  POLICY_SUMMARY,
  RECENT_DECISION_LIMIT,
  type RecentDecision,
} from "@/lib/admin/policy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "发布策略",
  robots: { index: false, follow: false },
};

export default async function PolicyPage() {
  let decisions: RecentDecision[] = [];
  let failed = false;
  try {
    decisions = await loadRecentDecisions(getDb());
  } catch (error) {
    console.error("[admin] recent decisions read failed", error);
    failed = true;
  }

  const autoPublish = POLICY_RULES.filter((rule) => rule.outcome === "published");
  const held = POLICY_RULES.filter((rule) => rule.outcome === "pending_review");

  return (
    <>
      <PageHeader
        title="发布策略"
        description="新版本什么时候自动发布、什么时候退回人工。规则由代码判定，本页只做翻译与举证。"
      />

      <div className="mb-6 flex flex-wrap items-start gap-3 surface-quiet px-4 py-3">
        <Lock aria-hidden className="mt-0.5 size-4 text-evidence-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-evidence-foreground">
            改规则需要改代码，后台不提供编辑。
          </p>
          <p className="mt-1 max-w-[78ch] text-xs leading-relaxed text-evidence-foreground">
            策略实现与判据在 <span className="font-mono">src/lib/moderation/policy.ts</span> 的{" "}
            <span className="font-mono">decideReleaseState</span>；审核快照存在产品的{" "}
            <span className="font-mono">capabilities_reviewed</span> /{" "}
            <span className="font-mono">name_at_review</span> /{" "}
            <span className="font-mono">repo_id_reviewed</span>。本页所有条目都是从那份代码与
            类型推导出来的，不在后台另存一份可改的配置——两处规则一定会漂移。
          </p>
        </div>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <div className="surface px-4 py-3">
          <p className="text-xs text-muted-foreground">会自动发布的判据</p>
          <p className="font-display mt-1 text-2xl font-semibold tabular-nums">
            {POLICY_SUMMARY.autoPublish}
          </p>
        </div>
        <div className="surface px-4 py-3">
          <p className="text-xs text-muted-foreground">退回人工的判据</p>
          <p className="font-display mt-1 text-2xl font-semibold tabular-nums">
            {POLICY_SUMMARY.heldForReview}
          </p>
        </div>
        <div className="surface px-4 py-3">
          <p className="text-xs text-muted-foreground">最近判定</p>
          <p className="font-display mt-1 text-2xl font-semibold tabular-nums">
            {decisions.length}
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              / 上限 {RECENT_DECISION_LIMIT}
            </span>
          </p>
        </div>
      </div>

      {POLICY_SUMMARY.drifted > 0 ? (
        <p
          role="alert"
          className="mb-6 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-xs leading-relaxed"
        >
          有 {POLICY_SUMMARY.drifted} 条判据与页面文案对不上：<span className="font-mono">decideReleaseState</span>{" "}
          已经不再按这条分支返回该原因。以代码为准，文案待更新。
        </p>
      ) : null}

      <div className="flex flex-col gap-6">
        <PolicyRuleList
          title="什么情况下自动发布"
          outcome="published"
          rules={autoPublish}
        />
        <PolicyRuleList
          title="什么情况下退回人工"
          outcome="pending_review"
          rules={held}
        />

        <section aria-labelledby="policy-recent-heading">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h2
              id="policy-recent-heading"
              className="font-display text-sm font-semibold"
            >
              最近判定
            </h2>
            <p className="text-[12.5px] text-muted-foreground">
              来自 <span className="font-mono">moderation_events</span> 的真实记录，最新 {RECENT_DECISION_LIMIT} 条
            </p>
          </div>
          {failed ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/5 px-6 py-8 text-center"
            >
              <p className="text-sm font-medium">读取最近判定失败</p>
              <p className="mx-auto mt-1 max-w-[52ch] text-xs leading-relaxed text-muted-foreground">
                数据库这次没有应答；上面的规则来自代码，不受影响。
              </p>
            </div>
          ) : (
            <PolicyRecentTable decisions={decisions} />
          )}
          <p className="mt-2 max-w-[86ch] text-[13px] leading-relaxed text-muted-foreground">
            只收录真实写入的判定动作：<span className="font-mono">re_review_required</span>
            （同步任务按策略拦下）、<span className="font-mono">approved</span> /{" "}
            <span className="font-mono">version.approved</span>（人工通过）。
          </p>
        </section>
      </div>
    </>
  );
}
