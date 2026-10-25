"use client";

import { useEffect, useState } from "react";
import { Toaster as SonnerToaster } from "sonner";

/**
 * The toast surface follows the same `dark` class the rest of the app switches on.
 * Sonner only understands a `theme` prop, so a MutationObserver mirrors the class
 * instead of adding a second source of truth (or a second theme store).
 */
function Toaster() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setTheme(root.classList.contains("dark") ? "dark" : "light");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return (
    <SonnerToaster
      theme={theme}
      position="bottom-right"
      offset={16}
      gap={8}
      toastOptions={{
        classNames: {
          toast:
            "rounded-md border border-border bg-popover text-popover-foreground text-xs shadow-lg",
          description: "text-muted-foreground",
        },
      }}
    />
  );
}

export { Toaster };
