"use client";

import type { ReactNode } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
} as const;

/**
 * The product's dialog. Header, body and footer are composed here once, so a feature
 * dialog only supplies content: no repeated `Dialog*` imports, no per-dialog paddings and
 * no second close button. The underlying primitive is still `ui/dialog` (Radix), which
 * keeps focus trapping, Escape and scroll locking correct.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  className,
  bodyClassName,
  headerExtra,
  trigger,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof SIZES;
  className?: string;
  bodyClassName?: string;
  headerExtra?: ReactNode;
  /** Optional element that opens the dialog (kept in the caller's own layout). */
  trigger?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent
        className={cn(
          "max-h-[calc(var(--viewport-h)-2rem)] overflow-y-auto rounded-panel border-border bg-card p-0",
          SIZES[size],
          className,
        )}
      >
        <DialogHeader className="flex-row items-start gap-3 border-b border-border px-5 py-4 pr-10">
          <div className="min-w-0 flex-1">
            <DialogTitle className="font-display text-[18px] font-semibold tracking-[-.01em]">
              {title}
            </DialogTitle>
            {description ? (
              <DialogDescription className="mt-0.5">{description}</DialogDescription>
            ) : null}
          </div>
          {headerExtra}
        </DialogHeader>
        {children ? (
          <div className={cn("px-5 py-4", bodyClassName)}>{children}</div>
        ) : null}
        {footer ? (
          <DialogFooter className="px-5 py-3">{footer}</DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
