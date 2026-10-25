import { ExternalLink, GitCommitHorizontal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { ReviewWorkflowHint, WorkflowRunVerdict } from "@/lib/github/actions";

/**
 * The only place a review surface describes CI (plan §7.4 item 25).
 *
 * It is a hint, and the copy says so: nothing here is a verdict on the submission, and the
 * approve action never reads it. For that reason the component deliberately has no wording
 * for "a build that was checked out and blessed" — that claim does not exist in this product
 * (AGENTS.md "GitHub App": `Actions: read` may only display, never gate).
 */

const VERDICT_LABELS: Record<WorkflowRunVerdict, string> = {
  success: "成功",
  failure: "失败",
  pending: "进行中",
  neutral: "无明确结论",
};

const VERDICT_TONES: Record<
  WorkflowRunVerdict,
  "success" | "destructive" | "warning" | "muted"
> = {
  success: "success",
  failure: "destructive",
  pending: "warning",
  neutral: "muted",
};

function shortSha(sha: string): string {
  return /^[0-9a-f]{7,}$/i.test(sha) ? sha.slice(0, 7) : sha;
}

export function WorkflowHint({ hint }: { hint: ReviewWorkflowHint }) {
  return (
    <div className="border-b border-border px-4 py-2.5 md:px-5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12.5px]">
        <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-medium">GitHub Actions</span>
        <span className="text-muted-foreground">
          release{" "}
          <span className="font-mono text-foreground/80">{hint.tag}</span> 的提交{" "}
          <span className="font-mono text-foreground/80">{shortSha(hint.commitSha)}</span>
        </span>
        <Badge variant={VERDICT_TONES[hint.verdict]}>
          结论：{VERDICT_LABELS[hint.verdict]}
        </Badge>
        <a
          href={hint.run.url}
          target="_blank"
          rel="noreferrer"
          className="relative inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
        >
          <ExternalLink className="size-3 shrink-0" aria-hidden />
          <span>查看运行记录</span>
          <span className="sr-only">（在新窗口打开）</span>
        </a>
      </div>
      <p className="mt-1 max-w-[72ch] text-[13px] leading-relaxed text-muted-foreground">
        {hint.runCount > 1
          ? `该提交共有 ${hint.runCount} 个工作流运行，这里取最差的一条结论，链接指向它。`
          : `工作流：${hint.run.name}。`}
        这是参考信息，不参与审核判定。
      </p>
    </div>
  );
}

/**
 * Streaming slot: the hint is fetched while the rest of the console renders, so a slow
 * GitHub API costs nothing on first paint. `null` renders nothing at all — not an empty
 * placeholder that would imply the check exists.
 */
export async function WorkflowHintSlot({
  hint,
}: {
  hint: Promise<ReviewWorkflowHint | null>;
}) {
  const resolved = await hint;
  return resolved ? <WorkflowHint hint={resolved} /> : null;
}
