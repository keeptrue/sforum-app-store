"use client";

import type { ReactNode } from "react";

import { Modal } from "@/components/common/modal";
import { FormError } from "@/components/common/field";
import { Button } from "@/components/ui/button";

/**
 * Destructive or irreversible confirmation. The caller owns the async call and passes
 * `pending`/`error`, so a failed action keeps the dialog open with the reason beside the
 * buttons instead of vanishing behind a toast.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = "确认",
  cancelLabel = "取消",
  tone = "default",
  pending = false,
  confirmDisabled = false,
  error,
  onConfirm,
  trigger,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  pending?: boolean;
  confirmDisabled?: boolean;
  error?: ReactNode;
  onConfirm: () => void;
  trigger?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="sm"
      bodyClassName="space-y-3"
      trigger={trigger}
      footer={
        <>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={pending || confirmDisabled}
          >
            {pending ? "处理中…" : confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {error ? <FormError>{error}</FormError> : null}
    </Modal>
  );
}
