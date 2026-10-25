"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GitBranch } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { jsonRequest } from "@/components/dashboard/api";
import { messageFor } from "@/components/dashboard/messages";
import { RepoPickerDialog } from "@/components/dashboard/repo-picker-dialog";
import { startNavProgress } from "@/lib/nav-progress";
import type { DashboardProductDetail } from "@/lib/products/types";

/**
 * Import a product from a repository.
 *
 * The release's manifest decides `extension_id`, name and kind, so the developer never
 * types an id that GitHub has to match later. The import also syncs that release, which
 * means the product arrives with its first version already in review instead of empty.
 */
export function ImportProductDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function pick(repoId: number) {
    setPending(true);
    setFailure(null);
    const result = await jsonRequest<{
      product: DashboardProductDetail;
      created: boolean;
    }>("/api/dashboard/products/import", "POST", { repoId });
    setPending(false);
    if (!result.ok) {
      setFailure(messageFor(result.failure));
      return;
    }
    setOpen(false);
    toast.success(result.data.created ? "产品已从仓库导入" : "已接管已有产品", {
      description: "首个版本已同步，接下来补齐文案再提交审核。",
    });
    startNavProgress();
    router.push(`/dashboard/products/${result.data.product.id}`);
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <GitBranch aria-hidden />
        从仓库导入
      </Button>

      <RepoPickerDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFailure(null);
        }}
        title="从 GitHub 仓库导入"
        description="读取仓库最新 release 里的 sforum.extension.json，用它的 ID、名称和类型建产品，并同步这个版本。"
        confirmLabel={pending ? "导入中…" : "导入"}
        pending={pending}
        failure={failure}
        onPick={(repoId) => void pick(repoId)}
      />
    </>
  );
}
