"use client";

import { useEffect, useState } from "react";

import type { ReadmeHeading } from "@/lib/readme/headings";

/**
 * Table of contents for a rendered README.
 *
 * The heading list arrives as a prop (`lib/readme/headings.ts` reads it out of the stored
 * HTML), so the contents are part of the server-rendered markup: it survives a page without
 * JavaScript and it does not pop in after hydration. Only the "which section am I in"
 * highlight needs the browser, because that is the one thing that depends on scroll position.
 *
 * Two shapes, one source: a sticky rail on wide screens (the card has ~400px of unused width
 * next to a 72ch prose column) and a collapsed `<details>` on narrow ones, where a second
 * column would squeeze the text instead.
 */

/** The section currently in the reading position, or `""` before the observer fires. */
function useActiveHeading(containerId: string, headings: ReadmeHeading[]): string {
  const [activeId, setActiveId] = useState("");

  useEffect(() => {
    if (headings.length === 0) return;
    const root = document.getElementById(containerId);
    if (!root) return;

    const targets = headings
      .map((heading) => root.querySelector<HTMLElement>(`#${CSS.escape(heading.id)}`))
      .filter((node): node is HTMLElement => node !== null);
    if (targets.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      // The band starts below the top bar and stops well before the fold, so the "active"
      // section is the one being read rather than the one that merely scrolled past.
      { rootMargin: "-96px 0px -70% 0px" },
    );
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [containerId, headings]);

  return activeId;
}

function TocList({ headings, activeId }: { headings: ReadmeHeading[]; activeId: string }) {
  return (
    <ol className="flex flex-col gap-0.5 text-[12.5px] leading-snug">
      {headings.map((heading) => {
        const indent =
          heading.level === 2 ? "pl-0" : heading.level === 3 ? "pl-3" : "pl-5";
        const active = heading.id === activeId;
        return (
          <li key={heading.id} className={indent}>
            <a
              href={`#${heading.id}`}
              aria-current={active ? "location" : undefined}
              className={
                "block truncate rounded-[6px] py-0.5 pr-1 transition-colors " +
                (active
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground")
              }
              title={heading.label}
            >
              {heading.label}
            </a>
          </li>
        );
      })}
    </ol>
  );
}

/** Sticky rail: only rendered where there is room for a second column. */
export function ReadmeTocRail({
  headings,
  containerId,
  className,
}: {
  headings: ReadmeHeading[];
  containerId: string;
  className?: string;
}) {
  const activeId = useActiveHeading(containerId, headings);
  if (headings.length < 3) return null;

  return (
    // Two boxes on purpose: `position: sticky` is bounded by its containing block, so the
    // outer box has to stretch to the full row height (grid default) while the inner one
    // travels. Making the nav itself the grid item would leave it stuck at the top of the
    // document, because its own box is only as tall as the list.
    <div className={className}>
      <nav
        aria-label="README 目录"
        className="sticky top-[calc(var(--app-topbar-h)+8px)] max-h-[calc(var(--viewport-h)-var(--app-topbar-h)-32px)] min-w-0 overflow-y-auto pb-2"
      >
        <p className="eyebrow mb-2">本文目录</p>
        <TocList headings={headings} activeId={activeId} />
      </nav>
    </div>
  );
}

/** Collapsed variant for narrow screens, where the rail has nowhere to go. */
export function ReadmeTocInline({
  headings,
  containerId,
}: {
  headings: ReadmeHeading[];
  containerId: string;
}) {
  const activeId = useActiveHeading(containerId, headings);
  if (headings.length < 3) return null;

  return (
    <details className="mb-4 rounded-cup border border-border bg-card px-3 py-2">
      <summary className="cursor-pointer text-[12.5px] font-medium text-muted-foreground hover:text-foreground">
        本文目录（{headings.length} 节）
      </summary>
      <div className="mt-2">
        <TocList headings={headings} activeId={activeId} />
      </div>
    </details>
  );
}
