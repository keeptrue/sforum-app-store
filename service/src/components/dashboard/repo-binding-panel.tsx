"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GitBranch, Loader2, Unlink } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { jsonRequest, requestJson } from "@/components/dashboard/api";
import {
  REPO_BOUND_VIA_LABELS,
  UPSTREAM_STATE_LABELS,
  UPSTREAM_STATE_TONES,
  formatDateTime,
} from "@/components/dashboard/labels";
import { messageFor } from "@/components/dashboard/messages";
import { RepoPickerDialog } from "@/components/dashboard/repo-picker-dialog";
import type { RepoBindingView } from "@/lib/products/binding";
import type { DashboardProductDetail } from "@/lib/products/types";

/**
 * Repository binding for one product.
 *
 * Every version the store ships comes from a release in this repository, so the panel is
 * explicit about three things: which repository, how the binding was established (an App
 * installation is *not* "verified identity"), and whether upstream is still reachable.
 * Re-binding is allowed at any status because review already treats it as a change
 * (`repo_changed`); unbinding a published product is not.
 */
export function RepoBindingPanel({
  product,
  binding,
}: {
  product: DashboardProductDetail;
  binding: RepoBindingView | null;
}) {
  const router = useRouter();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [unbinding, setUnbinding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function bind(repoId: number) {
    setPending(true);
    setFailure(null);
    const result = await jsonRequest<{ product: DashboardProductDetail }>(
      `/api/dashboard/products/${product.id}/repo`,
      "POST",
      { repoId },
    );
    setPending(false);
    if (!result.ok) {
      setFailure(messageFor(result.failure));
      return;
    }
    setPickerOpen(false);
    toast.success(binding ? "已换绑仓库" : "已绑定仓库", {
      description:
        product.status === "published"
          ? "已发布产品的仓库变更会重新进入审核。"
          : "下一个 release 会同步到这个产品。",
    });
    router.refresh();
  }

  async function unbind() {
    setUnbinding(true);
    setFailure(null);
    const result = await requestJson<{ product: DashboardProductDetail }>(
      `/api/dashboard/products/${product.id}/repo`,
      { method: "DELETE" },
    );
    setUnbinding(false);
    if (!result.ok) {
      setFailure(messageFor(result.failure));
      return;
    }
    toast.success("已解绑仓库");
    router.refresh();
  }

  const locked = product.status === "published";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>仓库</CardTitle>
          {binding ? (
            <Badge variant={UPSTREAM_STATE_TONES[binding.upstreamState]}>
              {UPSTREAM_STATE_LABELS[binding.upstreamState]}
            </Badge>
          ) : (
            <Badge variant="muted">未绑定</Badge>
          )}
        </div>
        <CardDescription>
          版本只来自 GitHub release；商城不存包体，也不接受手工上传的安装包。
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-3">
        {binding ? (
          <dl className="grid gap-2">
            <div className="grid gap-0.5">
              <dt className="text-[12.5px] text-muted-foreground">仓库</dt>
              <dd className="font-mono text-[12.5px] break-all">{binding.fullName}</dd>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {binding.private ? <Badge variant="outline">私有</Badge> : null}
              {binding.archived ? <Badge variant="muted">已归档</Badge> : null}
              {product.repoBoundVia ? (
                <Badge variant="outline">
                  {REPO_BOUND_VIA_LABELS[product.repoBoundVia]}
                </Badge>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-0.5">
                <dt className="text-[12.5px] text-muted-foreground">安装账号</dt>
                <dd className="font-mono text-[12.5px] break-all">
                  {binding.installationLogin}
                </dd>
              </div>
              <div className="grid gap-0.5">
                <dt className="text-[12.5px] text-muted-foreground">绑定时间</dt>
                <dd className="text-[12.5px]" title={product.repoBoundAt ?? undefined}>
                  {formatDateTime(product.repoBoundAt)}
                </dd>
              </div>
            </div>
          </dl>
        ) : (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            还没有绑定仓库。绑定之后，这个仓库的 release 才会同步成版本；在此之前到达的
            release 会进入「待认领」，不会自动创建产品。
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant={binding ? "outline" : "default"}
            onClick={() => setPickerOpen(true)}
            disabled={pending || unbinding}
          >
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : <GitBranch aria-hidden />}
            {binding ? "换绑仓库" : "选择仓库"}
          </Button>

          {binding ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void unbind()}
              disabled={locked || unbinding || pending}
            >
              {unbinding ? <Loader2 className="animate-spin" aria-hidden /> : <Unlink aria-hidden />}
              解绑
            </Button>
          ) : null}
        </div>

        {locked && binding ? (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            已发布的产品不能解绑仓库：下载链接和审核快照都建立在它之上。换绑可以，但会重新进入审核。
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
      </CardContent>

      <RepoPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title={binding ? "换绑仓库" : "选择仓库"}
        description="只列出 GitHub App 已授权、且属于当前账号安装的仓库。"
        confirmLabel={binding ? "换绑" : "绑定"}
        pending={pending}
        onPick={(repoId) => void bind(repoId)}
      />
    </Card>
  );
}
