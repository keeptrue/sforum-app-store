"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { FormError } from "@/components/common/field";
import { Modal } from "@/components/common/modal";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { jsonRequest } from "@/components/dashboard/api";
import { messageFor } from "@/components/dashboard/messages";
import type { DashboardProductDetail, DashboardVersion } from "@/lib/products/types";

const REASON_MAX = 500;

/**
 * Yank is irreversible from the developer side and takes effect immediately (the public detail
 * drops the version and every outstanding signed link answers 410), so the reason is mandatory
 * and the submit control stays disabled until there is one.
 */
export function YankDialog({
  version,
  open,
  onOpenChange,
}: {
  version: DashboardVersion | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = reason.trim();
  const ready = trimmed.length > 0 && trimmed.length <= REASON_MAX;

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setReason("");
      setError(null);
      setPending(false);
    }
  }

  async function yank() {
    if (!version) return;
    setPending(true);
    setError(null);
    const result = await jsonRequest<{ product: DashboardProductDetail }>(
      `/api/dashboard/versions/${version.id}/yank`,
      "POST",
      { reason: trimmed },
    );
    setPending(false);
    if (!result.ok) {
      setError(messageFor(result.failure));
      return;
    }
    toast.success(`版本 ${version.version} 已撤回`, {
      description: "下载入口立即失效，已签发的链接返回 410。",
    });
    close(false);
    router.refresh();
  }

  return (
    <Modal
      open={open}
      onOpenChange={close}
      title={
        <>
          撤回版本{" "}
          <span className="font-mono text-xs text-muted-foreground">
            {version?.version ?? ""}
          </span>
        </>
      }
      description="撤回后这个版本从目录与详情页消失，下载链接立即失效。操作不可撤销，理由会写进审核事件与审计日志。"
      footer={
        <>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => close(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={!ready || pending}
            onClick={() => void yank()}
          >
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            确认撤回
          </Button>
        </>
      }
    >
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="yank-reason" className="text-xs font-medium">
            撤回理由
          </label>
          <span className="text-[12.5px] tabular-nums text-muted-foreground">
            {reason.length}/{REASON_MAX}
          </span>
        </div>
        <Textarea
          id="yank-reason"
          value={reason}
          maxLength={REASON_MAX}
          rows={3}
          autoFocus
          placeholder="例如：该版本在 PostgreSQL 16 上会丢失迁移记录。"
          onChange={(event) => setReason(event.target.value)}
          aria-describedby="yank-reason-hint"
        />
        <p id="yank-reason-hint" className="text-[12.5px] text-muted-foreground">
          1–500 字，必须填写。
        </p>
        {error ? <FormError>{error}</FormError> : null}
      </div>
    </Modal>
  );
}
