"use client";

import { useState, type ReactNode } from "react";

import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Textarea } from "@/components/ui/textarea";

import {
  useModerationSubmit,
  type ModerationAction,
  type ModerationTarget,
} from "./mutation";

/** reject/delist need 1..500 characters; the API rejects an empty reason. */
const REASON_MAX = 500;

export type ReasonField = { label: string; placeholder: string };

/**
 * One dialog for both shapes: approve needs a confirmation, reject/delist need a reason.
 * Submit stays disabled while the reason is missing or a request is in flight, and a
 * blocking error is rendered inside the dialog rather than in a toast that disappears.
 */
export function ModerationDialog({
  trigger,
  title,
  description,
  confirmLabel,
  target,
  action,
  success,
  destructive = false,
  reason,
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  confirmLabel: string;
  target: ModerationTarget;
  action: ModerationAction;
  success: string;
  destructive?: boolean;
  reason?: ReasonField;
}) {
  const { pending, error, clearError, run } = useModerationSubmit();
  const [open, setOpen] = useState(false);
  const [reasonText, setReasonText] = useState("");

  const requiresReason = Boolean(reason);
  const trimmed = reasonText.trim();
  const canSubmit = !pending && (!requiresReason || trimmed.length > 0);

  function handleOpenChange(next: boolean) {
    if (next) {
      clearError();
      setOpen(true);
      return;
    }
    if (pending) return;
    setOpen(false);
    setReasonText("");
    clearError();
  }

  async function submit() {
    if (!canSubmit) return;
    const ok = await run(target, action, {
      body: requiresReason ? { reason: trimmed } : undefined,
      success,
    });
    if (!ok) return;
    setReasonText("");
    setOpen(false);
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={handleOpenChange}
      trigger={trigger}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      tone={destructive ? "danger" : "default"}
      pending={pending}
      confirmDisabled={!canSubmit}
      error={error}
      onConfirm={() => void submit()}
    >
      {reason ? (
        <div>
          <label className="block space-y-1.5">
            <span className="text-[12.5px] font-medium">{reason.label}</span>
            <Textarea
              value={reasonText}
              onChange={(event) => setReasonText(event.target.value)}
              placeholder={reason.placeholder}
              maxLength={REASON_MAX}
              rows={3}
              aria-invalid={error ? true : undefined}
              className="min-h-16 text-xs leading-relaxed"
            />
          </label>
          <div className="mt-1 flex items-center justify-between gap-2 text-[12px] text-muted-foreground">
            <span>理由会写进审核事件，开发者能看到。</span>
            <span className="tabular-nums">
              {reasonText.length}/{REASON_MAX}
            </span>
          </div>
        </div>
      ) : null}
    </ConfirmDialog>
  );
}
