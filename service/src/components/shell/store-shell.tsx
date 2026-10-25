import { Suspense } from "react";
import Link from "next/link";
import { UserRound } from "lucide-react";

import { AppShell } from "@/components/shell/app-shell";
import { StoreNav } from "@/components/shell/store-nav";
import { StorePortalCard } from "@/components/shell/store-portal-card";
import { StoreSearch } from "@/components/shell/store-search";

/**
 * Storefront chrome. The rail and the bar read `useSearchParams` for their active state,
 * so each sits behind its own Suspense boundary — the shell never shifts when the client
 * parts hydrate.
 */
export function StoreShell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell
      brand={{ href: "/", title: "SForum Store", subtitle: "扩展商城" }}
      nav={
        <Suspense fallback={null}>
          <StoreNav />
        </Suspense>
      }
      railFooter={<StorePortalCard />}
      topbarStart={
        <Suspense
          fallback={<div className="h-10 max-w-[430px] flex-1" aria-hidden />}
        >
          <StoreSearch />
        </Suspense>
      }
      topbarEnd={
        <Link
          href="/dashboard"
          aria-label="开发者门户"
          className="press grid size-9 place-items-center rounded-pill border border-input bg-card text-muted-foreground hover:text-foreground"
        >
          <UserRound className="size-4" aria-hidden />
        </Link>
      }
      mainClassName="px-[18px] pb-14 lg:px-9"
    >
      {children}
    </AppShell>
  );
}
