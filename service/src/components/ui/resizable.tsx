import * as React from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import { cn } from "@/lib/utils";

function ResizeHandle({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      className={cn(
        "relative w-px bg-border transition-colors after:absolute after:inset-y-0 after:-left-1 after:-right-1 after:content-[''] hover:bg-foreground/30 data-[state=drag]:bg-foreground/50",
        className,
      )}
      {...props}
    />
  );
}

export { Group as PanelGroup, Panel, ResizeHandle };
