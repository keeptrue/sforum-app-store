import { Suspense } from "react";
import Link from "next/link";

import { BrandMark } from "@/components/brand-mark";
import { MobileNav } from "@/components/shell/mobile-nav";
import { NavProgress } from "@/components/shell/nav-progress";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { cn } from "@/lib/utils";

export type AppShellBrand = {
  href: string;
  title: string;
  subtitle: string;
};

/**
 * The single frame for every face of the product.
 *
 * Storefront, developer console and admin console differ only in the nav they pass in and
 * the top-bar slots they fill — rail width, brand block, active-link style, bar height,
 * theme switch and the mobile sheet are defined once here. That is what keeps the admin
 * console visually the same product as the shop window without copying a layout.
 *
 * The shell renders `<main>`: pages own their content, never their chrome.
 */
export function AppShell({
  brand,
  nav,
  railFooter,
  topbarStart,
  topbarEnd,
  mainClassName,
  children,
}: {
  brand: AppShellBrand;
  nav: React.ReactNode;
  railFooter?: React.ReactNode;
  topbarStart?: React.ReactNode;
  topbarEnd?: React.ReactNode;
  mainClassName?: string;
  children: React.ReactNode;
}) {
  const brandBlock = (
    <Link href={brand.href} className="flex items-center gap-[11px] px-2">
      <BrandMark size={34} />
      <span className="min-w-0">
        <b className="block text-[15px] tracking-[-.01em]">{brand.title}</b>
        <span className="mt-px block text-[12.5px] text-muted-foreground">
          {brand.subtitle}
        </span>
      </span>
    </Link>
  );

  return (
    <div className="min-h-[var(--viewport-h)] lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-[var(--viewport-h)] flex-col border-r border-border px-4 py-[22px] lg:flex">
        {brandBlock}
        <div className="scrollbar-thin mt-[18px] min-h-0 flex-1 overflow-y-auto">
          {nav}
        </div>
        {railFooter ? <div className="mt-4 shrink-0">{railFooter}</div> : null}
      </aside>

      <div className="min-w-0">
        <div className="sticky top-0 z-30 flex h-[var(--app-topbar-h)] items-center gap-2 border-b border-border bg-background/85 px-[18px] backdrop-blur-md lg:gap-3 lg:px-9">
          <MobileNav brand={brandBlock} footer={railFooter}>
            {nav}
          </MobileNav>

          <Link
            href={brand.href}
            className="flex items-center gap-2 lg:hidden"
            aria-label={`${brand.title} 首页`}
          >
            <BrandMark size={26} />
            <span className="hidden text-[15px] font-semibold tracking-[-.01em] sm:block">
              {brand.title}
            </span>
          </Link>

          <div className="min-w-0 flex-1">{topbarStart}</div>

          <div className="flex shrink-0 items-center gap-2">
            {topbarEnd}
            <ThemeToggle />
          </div>

          {/*
           * The bar is the bar's own child, so `sticky` already contains it: it rides the
           * bottom edge of the header and replaces the hairline border while it fills.
           * Suspense because it reads `useSearchParams` — the shell must not opt every
           * page out of static rendering for a 2px line.
           */}
          <Suspense fallback={null}>
            <NavProgress />
          </Suspense>
        </div>

        <main className={cn("min-w-0", mainClassName)}>{children}</main>
      </div>
    </div>
  );
}
