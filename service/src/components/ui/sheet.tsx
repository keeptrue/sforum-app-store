"use client";

import type * as React from "react";
import { Dialog as SheetPrimitive } from "radix-ui";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Off-canvas panel for narrow viewports. Built on the same Radix dialog primitive as
 * `Modal`, so focus trapping, scroll locking and Escape behave identically; only the
 * geometry and the entrance animation differ.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <SheetPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <SheetPrimitive.Portal>
        <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[2px] data-[state=open]:animate-[overlay-in_120ms_ease-out]" />
        <SheetPrimitive.Content
          data-slot="sheet-content"
          className={cn(
            "fixed inset-y-0 left-0 z-50 flex w-[288px] max-w-[86vw] flex-col border-r border-border bg-sidebar data-[state=open]:animate-[sheet-in_160ms_cubic-bezier(.32,.72,0,1)]",
            className,
          )}
        >
          <SheetPrimitive.Title className="sr-only">{title}</SheetPrimitive.Title>
          <SheetPrimitive.Description className="sr-only">
            {description ?? title}
          </SheetPrimitive.Description>
          {children}
          <SheetPrimitive.Close className="press absolute right-3 top-4 grid size-8 place-items-center rounded-pill text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-4" aria-hidden />
            <span className="sr-only">关闭导航</span>
          </SheetPrimitive.Close>
        </SheetPrimitive.Content>
      </SheetPrimitive.Portal>
    </SheetPrimitive.Root>
  );
}
