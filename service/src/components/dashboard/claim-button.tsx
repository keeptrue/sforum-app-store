"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, PackageCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { jsonRequest } from "@/components/dashboard/api";
import { messageFor } from "@/components/dashboard/messages";
import { startNavProgress } from "@/lib/nav-progress";
import type { DashboardProductDetail } from "@/lib/products/types";

/**
 * Claim one waiting release.
 *
 * The server re-reads the release instead of trusting the stored manifest name, so a claim
 * always produces the product the release actually describes. The button reports the real
 * failure inline; a claim that another request already settled comes back as a conflict
 * rather than a second success.
 */
export function ClaimButton({
  claimId,
  label = "认领",
}: {
  claimId: string;
  label?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function claim() {
    setPending(true);
    setFailure(null);
    const result = await jsonRequest<{
      product: DashboardProductDetail;
      created: boolean;
    }>(`/api/dashboard/repo-claims/${claimId}/claim`, "POST", {});
    setPending(false);
    if (!result.ok) {
      setFailure(messageFor(result.failure));
      return;
    }
    toast.success(result.data.created ? "已认领并创建产品" : "已认领", {
      description: "首个版本已同步，去产品页补齐文案。",
    });
    startNavProgress();
    router.push(`/dashboard/products/${result.data.product.id}`);
  }

  return (
    <div className="grid gap-1.5">
      <Button type="button" size="sm" disabled={pending} onClick={() => void claim()}>
        {pending ? (
          <Loader2 className="animate-spin" aria-hidden />
        ) : (
          <PackageCheck aria-hidden />
        )}
        {label}
      </Button>
      {failure ? (
        <p role="alert" className="text-[13px] leading-relaxed text-destructive">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
