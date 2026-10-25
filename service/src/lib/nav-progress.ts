/**
 * Route-change progress: the pure half.
 *
 * The App Router has no navigation events. A click is consumed inside `next/link`, the RSC
 * payload is fetched, and only then does the URL commit — the window between those two
 * moments is invisible to React, and it is exactly the window where a slow server makes a
 * click feel ignored. Nothing here touches the DOM: this module only decides whether a
 * click starts a navigation, how far the bar creeps while it waits, and how the phases
 * move. `components/shell/nav-progress.tsx` owns the timers and the pixels.
 *
 * The bar is deliberately dishonest about one thing and honest about another: it never
 * claims to know how much is left (it asymptotes at 94%), and it never claims to be done
 * until the URL actually changed.
 */

export const NAV_PROGRESS_TIMING = {
  /** First value after a start, as a fraction of the bar's width. */
  start: 0.08,
  /** The trickle stops here. Only a committed route may reach 100%. */
  ceiling: 0.94,
  /**
   * Time constant of the trickle. Small enough that the first 300ms read as motion, large
   * enough that the bar is still visibly moving ten seconds in — a bar that parks at 90%
   * within a second looks as frozen as no bar at all.
   */
  tauMs: 2000,
  /** How often the value is recomputed. Also the width transition duration in CSS. */
  tickMs: 200,
  /**
   * Nothing is painted before this. A navigation that resolves in 40ms would otherwise
   * flash a 2px line on every prefetched click, which reads as a glitch rather than as
   * feedback. Below the threshold the user never learns the bar exists.
   */
  showDelayMs: 100,
  /** Past this the bar breathes in place, which says "still working" without lying. */
  stallMs: 1200,
  /**
   * A navigation that never commits — a server error rendered in place, a handler that
   * decided not to move — must not leave the line crawling for the rest of the session.
   */
  watchdogMs: 20_000,
  /**
   * How long the settling bar is held before it is torn down. Must outlast the CSS fade in
   * `globals.css` (80ms delay + 180ms) or the line is pulled mid-fade and pops.
   */
  settleMs: 300,
} as const;

export type NavProgressPhase = "idle" | "running" | "settling";

export type NavProgressState = {
  phase: NavProgressPhase;
  /** 0..1 — the bar's width. While running it is capped at `ceiling`. */
  value: number;
  /** The navigation outlived the show delay, so the bar is allowed to paint. */
  visible: boolean;
  /** The wait is long enough that the bar should pulse instead of advancing. */
  stalled: boolean;
};

export const NAV_PROGRESS_IDLE: NavProgressState = Object.freeze({
  phase: "idle",
  value: 0,
  visible: false,
  stalled: false,
});

export type NavProgressAction =
  | { type: "start" }
  | { type: "show" }
  | { type: "tick"; elapsedMs: number }
  | { type: "stall" }
  | { type: "commit" }
  | { type: "reset" };

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Moves the bar forward by `elapsedMs` of waiting.
 *
 * Exponential approach to the ceiling: composing small steps is exactly equivalent to one
 * large step, so a throttled background tab that fires one tick late lands where a smooth
 * stream of ticks would have. `value` is treated as the current position, never as a
 * starting point, so a repeated call cannot double-count time.
 */
export function advanceProgress(value: number, elapsedMs: number): number {
  const { ceiling, tauMs } = NAV_PROGRESS_TIMING;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return clampFraction(value);
  const from = Math.min(clampFraction(value), ceiling);
  return ceiling - (ceiling - from) * Math.exp(-elapsedMs / tauMs);
}

/** Everything the click handler knows about a press, with no DOM types in the signature. */
export type NavClick = {
  /** Absolute URL the anchor points at (`HTMLAnchorElement.href` is already resolved). */
  href: string;
  /** Absolute URL of the document the click happened in. */
  currentHref: string;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** The anchor's `target` attribute, "" when absent. */
  target: string;
  /** The anchor carries `download`. */
  download: boolean;
  /** The anchor carries `data-no-progress`, the per-link opt-out. */
  optOut: boolean;
};

function parseHttpUrl(href: string): URL | null {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Does this press start a client-side navigation the bar should follow?
 *
 * Everything that leaves the document (external origin, `target`, `download`, a modifier
 * that opens a tab) is excluded: the browser paints its own progress for those, and the
 * bar would never receive the URL change that ends it. Same path and search is excluded
 * too — clicking the nav item you are already on, or a `#anchor`, does no server work.
 */
export function shouldTrackClick(click: NavClick): boolean {
  if (click.button !== 0) return false;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false;
  if (click.optOut || click.download) return false;
  if (click.target && click.target !== "_self") return false;

  const target = parseHttpUrl(click.href);
  const current = parseHttpUrl(click.currentHref);
  if (!target || !current) return false;
  if (target.origin !== current.origin) return false;

  return target.pathname !== current.pathname || target.search !== current.search;
}

/**
 * The phase machine.
 *
 * `start` is idempotent while running: a second click during the same navigation must not
 * yank the bar back to 8%. Every timer action is ignored outside the phase that scheduled
 * it, so a late tick from a cleared timer can never resurrect a settled bar.
 */
export function reduceNavProgress(
  state: NavProgressState,
  action: NavProgressAction,
): NavProgressState {
  switch (action.type) {
    case "start":
      if (state.phase === "running") return state;
      return {
        phase: "running",
        value: NAV_PROGRESS_TIMING.start,
        visible: false,
        stalled: false,
      };
    case "show":
      if (state.phase !== "running" || state.visible) return state;
      return { ...state, visible: true };
    case "tick": {
      if (state.phase !== "running") return state;
      const value = advanceProgress(state.value, action.elapsedMs);
      return value === state.value ? state : { ...state, value };
    }
    case "stall":
      if (state.phase !== "running" || state.stalled) return state;
      return { ...state, stalled: true };
    case "commit":
      if (state.phase !== "running") return state;
      // A navigation that barely outlived the show delay gets the fade, not the victory
      // lap: the full-width jump would be the loudest thing on screen for a wait the user
      // never noticed. One tick is the line between "glanced at it" and "waited".
      return {
        ...state,
        phase: "settling",
        value: state.value > NAV_PROGRESS_TIMING.start ? 1 : state.value,
        stalled: false,
      };
    case "reset":
      return state.phase === "idle" ? state : NAV_PROGRESS_IDLE;
    default:
      return state;
  }
}

type Listener = (action: NavProgressAction) => void;

const listeners = new Set<Listener>();

/**
 * Imperative entry point for navigations with no click to intercept — `router.push` after
 * an async form handler, for instance. The URL change still ends the navigation; this only
 * supplies the start.
 */
export function startNavProgress(): void {
  for (const listener of listeners) listener({ type: "start" });
}

/** The bar subscribes with its reducer's dispatch; returns the unsubscribe. */
export function subscribeNavProgress(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
