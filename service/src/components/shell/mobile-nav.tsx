"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { usePathname } from "next/navigation";

import { Sheet } from "@/components/ui/sheet";

/**
 * Below `lg` the rail folds away, so the shell keeps the same navigation in a sheet.
 * The sheet closes on navigation: a client component inside a persistent layout would
 * otherwise stay open over the next page.
 */
export function MobileNav({
  brand,
  children,
  footer,
}: {
  brand: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="打开导航"
        className="press grid size-9 shrink-0 place-items-center rounded-pill border border-border bg-card text-muted-foreground hover:text-foreground lg:hidden"
      >
        <Menu className="size-4" aria-hidden />
      </button>
      <Sheet open={open} onOpenChange={setOpen} title="导航">
        <div className="px-4 pb-4 pt-5">{brand}</div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">{children}</div>
        {footer ? (
          <div className="border-t border-border px-4 py-3">{footer}</div>
        ) : null}
      </Sheet>
    </>
  );
}
