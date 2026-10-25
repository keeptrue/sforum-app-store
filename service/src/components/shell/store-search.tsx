"use client";

import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";

/**
 * Search is a plain GET form to `/`, so a shared URL carries the query. The input remounts
 * on `q` change (`key`) instead of becoming controlled state that can drift from the URL.
 */
export function StoreSearch() {
  const params = useSearchParams();
  const q = params.get("q") ?? "";

  return (
    <form
      action="/"
      role="search"
      className="flex h-10 min-w-0 max-w-[430px] flex-1 items-center gap-2.5 rounded-pill border border-border bg-card px-3.5 text-muted-foreground transition-colors focus-within:border-foreground/40"
    >
      <Search className="size-[15px] shrink-0" strokeWidth={1.9} aria-hidden />
      <input
        key={q}
        type="search"
        name="q"
        defaultValue={q}
        aria-label="搜索扩展"
        placeholder="搜索扩展、ID 或摘要"
        className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
      />
    </form>
  );
}
