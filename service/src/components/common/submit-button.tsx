"use client";

import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Submit button with the product's one pending treatment: a spinner in place of the icon
 * slot, the label kept visible, and the button disabled. Prevents the double-submit bug
 * that every hand-written form otherwise reintroduces.
 */
export function SubmitButton({
  pending = false,
  pendingLabel,
  children,
  className,
  ...props
}: React.ComponentProps<typeof Button> & {
  pending?: boolean;
  pendingLabel?: string;
}) {
  return (
    <Button type="submit" disabled={pending} className={cn(className)} {...props}>
      {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
