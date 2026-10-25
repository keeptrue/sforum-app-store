"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useReducer } from "react";

import {
  NAV_PROGRESS_IDLE,
  NAV_PROGRESS_TIMING,
  reduceNavProgress,
  shouldTrackClick,
  startNavProgress,
  subscribeNavProgress,
} from "@/lib/nav-progress";

/**
 * The loading line under the top bar.
 *
 * Every navigation in this product is a server round trip — the catalogue, the developer
 * console and the admin tables are all rendered per request — so a slow moment after a
 * click looks exactly like a click that did nothing. This is the answer: one 2px ink line
 * that appears ~100ms after the press and stays until the URL commits.
 *
 * The App Router offers no navigation events, so the start comes from two places: a
 * capture-phase click listener on the document (links) and `startNavProgress()` for the
 * handlers that `router.push` after an async action. The end is honest — only a committed
 * pathname/search ends a navigation. `reduceNavProgress` holds the rules; this file is
 * timers and pixels.
 *
 * Timers live here rather than in the reducer so React owns their cleanup: a phase change
 * clears every timer the previous phase scheduled, which is what keeps a late tick from
 * resurrecting a bar that already settled.
 */
export function NavProgress() {
  const [state, dispatch] = useReducer(reduceNavProgress, NAV_PROGRESS_IDLE);
  const pathname = usePathname();
  const search = useSearchParams().toString();

  // Imperative starts arrive as reducer actions; the URL change below still ends them.
  useEffect(() => subscribeNavProgress(dispatch), []);

  // The one honest completion signal the App Router gives a client component. Query-only
  // navigations (catalogue filters) change `search` but not `pathname`, so both are read.
  useEffect(() => {
    dispatch({ type: "commit" });
  }, [pathname, search]);

  useEffect(() => {
    if (state.phase !== "running") return;

    let last = performance.now();
    const show = window.setTimeout(
      () => dispatch({ type: "show" }),
      NAV_PROGRESS_TIMING.showDelayMs,
    );
    const stall = window.setTimeout(
      () => dispatch({ type: "stall" }),
      NAV_PROGRESS_TIMING.stallMs,
    );
    // Nothing commits when a route throws in place; without this the line would crawl for
    // the rest of the session. The next click starts a fresh bar.
    const watchdog = window.setTimeout(
      () => dispatch({ type: "reset" }),
      NAV_PROGRESS_TIMING.watchdogMs,
    );
    const tick = window.setInterval(() => {
      const now = performance.now();
      dispatch({ type: "tick", elapsedMs: now - last });
      last = now;
    }, NAV_PROGRESS_TIMING.tickMs);

    return () => {
      window.clearTimeout(show);
      window.clearTimeout(stall);
      window.clearTimeout(watchdog);
      window.clearInterval(tick);
    };
  }, [state.phase]);

  useEffect(() => {
    if (state.phase !== "settling") return;
    const timer = window.setTimeout(
      () => dispatch({ type: "reset" }),
      NAV_PROGRESS_TIMING.settleMs,
    );
    return () => window.clearTimeout(timer);
  }, [state.phase]);

  // Capture phase on purpose: the bar must start on the press, before `next/link` has
  // fetched anything. `defaultPrevented` is not inspected — Link calls preventDefault
  // itself to take the navigation over, so it is always true by the time a bubble-phase
  // listener runs.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;

      const track = shouldTrackClick({
        href: anchor.href,
        currentHref: window.location.href,
        button: event.button,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        target: anchor.target,
        download: anchor.hasAttribute("download"),
        optOut: anchor.dataset.noProgress !== undefined,
      });
      if (track) startNavProgress();
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // `running` before the show delay paints nothing: a prefetched navigation resolves in
  // tens of milliseconds, and a flash on every click is worse than no bar at all.
  const painted = state.phase === "running" && !state.visible ? "idle" : state.phase;

  return (
    <>
      {/* The line itself is decoration; this is the part a screen reader hears, once. */}
      <span role="status" className="sr-only">
        {state.phase === "running" && state.visible ? "页面加载中" : ""}
      </span>
      <div
        aria-hidden
        data-phase={painted}
        data-stalled={state.stalled ? "true" : undefined}
        style={{ width: `${Math.round(state.value * 1000) / 10}%` }}
        className="nav-progress pointer-events-none absolute -bottom-px left-0 h-0.5 bg-foreground"
      />
    </>
  );
}
