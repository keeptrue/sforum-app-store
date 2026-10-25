"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { requestJson } from "@/components/dashboard/api";
import { canSubmit } from "@/components/dashboard/labels";
import { messageFor } from "@/components/dashboard/messages";
import type { DashboardProductDetail, ProductStatus } from "@/lib/products/types";

/**
 * Submit for review. The button is enabled by state alone (`draft` / `rejected`) — the two
 * preconditions a developer cannot always meet in the UI (a reviewable version, non-empty copy)
 * are decided by the API, and its 409 code is rendered here as guidance rather than a toast
 * that disappears.
 */
export function SubmitReviewButton({
  productId,
  status,
  reviewableCount,
}: {
  productId: string;
  status: ProductStatus;
  reviewableCount: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const allowed = canSubmit(status);
  const blockedReason =
    status === "pending_review"
      ? "已在审核队列里，等待结论即可。"
      : status === "published"
        ? "已发布；后续版本满足条件会自动发布，不需要提交。"
        : status === "delisted"
          ? "已下架。提交入口只对草稿与被拒产品开放。"
          : null;

  async function submit() {
    setPending(true);
    setFailure(null);
    const result = await requestJson<{ product: DashboardProductDetail }>(
      `/api/dashboard/products/${productId}/submit`,
      { method: "POST" },
    );
    setPending(false);
    if (!result.ok) {
      setFailure(messageFor(result.failure));
      return;
    }
    toast.success("已提交审核", {
      description: "审核结论出来后，产品状态会更新。",
    });
    router.refresh();
  }

  return (
    <div className="grid gap-2">
      <Button
        type="button"
        size="sm"
        disabled={!allowed || pending}
        onClick={() => void submit()}
      >
        {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
        提交审核
      </Button>

      {!allowed && blockedReason ? (
        <p className="text-[13px] leading-relaxed text-muted-foreground">{blockedReason}</p>
      ) : null}

      {allowed ? (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          当前有 {reviewableCount} 个可审版本（candidate / pending_review）。
        </p>
      ) : null}

      {failure ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[13px] leading-relaxed text-destructive"
        >
          {failure}
        </p>
      ) : null}
    </div>
  );
}
