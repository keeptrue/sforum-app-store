import { describe, expect, test } from "bun:test";

import {
  advanceProgress,
  NAV_PROGRESS_IDLE,
  NAV_PROGRESS_TIMING,
  reduceNavProgress,
  shouldTrackClick,
  startNavProgress,
  subscribeNavProgress,
  type NavClick,
  type NavProgressAction,
  type NavProgressState,
} from "./nav-progress";

const CLICK: NavClick = {
  href: "https://store.test/dashboard",
  currentHref: "https://store.test/",
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  target: "",
  download: false,
  optOut: false,
};

const click = (patch: Partial<NavClick>): NavClick => ({ ...CLICK, ...patch });

/** Drives the reducer the way the component's timers do. */
function run(actions: NavProgressAction[]): NavProgressState {
  return actions.reduce(reduceNavProgress, NAV_PROGRESS_IDLE);
}

describe("advanceProgress", () => {
  test("creeps without ever reaching the ceiling", () => {
    expect(advanceProgress(NAV_PROGRESS_TIMING.start, 200)).toBeCloseTo(0.1618, 4);
    expect(advanceProgress(0.5, 2000)).toBeCloseTo(0.94 - 0.44 * Math.E ** -1, 4);

    let value = NAV_PROGRESS_TIMING.start;
    for (let i = 0; i < 500; i += 1) value = advanceProgress(value, 200);
    expect(value).toBeGreaterThan(0.93);
    expect(value).toBeLessThanOrEqual(NAV_PROGRESS_TIMING.ceiling);
  });

  test("is monotonic and time-additive", () => {
    let value = NAV_PROGRESS_TIMING.start;
    let previous = value;
    for (let i = 0; i < 60; i += 1) {
      value = advanceProgress(value, 200);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }

    // Two 200ms steps land where one 400ms step would: a throttled tab that fires one late
    // tick must not fall behind a smooth stream of ticks.
    const stepped = advanceProgress(advanceProgress(0.08, 200), 200);
    expect(stepped).toBeCloseTo(advanceProgress(0.08, 400), 10);
  });

  test("never moves backwards on bad input", () => {
    expect(advanceProgress(0.3, 0)).toBe(0.3);
    expect(advanceProgress(0.3, -50)).toBe(0.3);
    expect(advanceProgress(0.3, Number.NaN)).toBe(0.3);
    // A corrupt value restarts the trickle from 0 instead of poisoning the width.
    expect(advanceProgress(Number.NaN, 200)).toBeCloseTo(0.0895, 4);
    expect(advanceProgress(0.99, 200)).toBe(NAV_PROGRESS_TIMING.ceiling);
  });
});

describe("shouldTrackClick", () => {
  test("tracks a same-origin path change", () => {
    expect(shouldTrackClick(CLICK)).toBe(true);
    expect(
      shouldTrackClick(click({ href: "https://store.test/?category=theme" })),
    ).toBe(true);
  });

  test("ignores presses that do not navigate this document", () => {
    expect(shouldTrackClick(click({ href: "https://elsewhere.test/dashboard" }))).toBe(false);
    expect(shouldTrackClick(click({ target: "_blank" }))).toBe(false);
    expect(shouldTrackClick(click({ target: "_self" }))).toBe(true);
    expect(shouldTrackClick(click({ download: true }))).toBe(false);
    expect(shouldTrackClick(click({ optOut: true }))).toBe(false);
    expect(shouldTrackClick(click({ button: 1 }))).toBe(false);
    expect(shouldTrackClick(click({ metaKey: true }))).toBe(false);
    expect(shouldTrackClick(click({ ctrlKey: true }))).toBe(false);
    expect(shouldTrackClick(click({ shiftKey: true }))).toBe(false);
    expect(shouldTrackClick(click({ altKey: true }))).toBe(false);
  });

  test("ignores targets that are not a page fetch", () => {
    expect(shouldTrackClick(click({ href: "mailto:hi@store.test" }))).toBe(false);
    expect(shouldTrackClick(click({ href: "javascript:void(0)" }))).toBe(false);
    expect(shouldTrackClick(click({ href: "not a url" }))).toBe(false);
  });

  test("ignores clicks that resolve to the page already shown", () => {
    expect(
      shouldTrackClick(
        click({ href: "https://store.test/", currentHref: "https://store.test/" }),
      ),
    ).toBe(false);
    // Same path, different hash: the browser scrolls, the server is never asked.
    expect(
      shouldTrackClick(
        click({
          href: "https://store.test/dashboard#releases",
          currentHref: "https://store.test/dashboard",
        }),
      ),
    ).toBe(false);
    // Same path, different query: the server renders a new list, so this is a real wait.
    expect(
      shouldTrackClick(
        click({
          href: "https://store.test/?q=zip",
          currentHref: "https://store.test/",
        }),
      ),
    ).toBe(true);
  });
});

describe("reduceNavProgress", () => {
  test("runs, becomes visible after the delay, then settles", () => {
    const running = run([{ type: "start" }]);
    expect(running.phase).toBe("running");
    expect(running.value).toBe(NAV_PROGRESS_TIMING.start);
    expect(running.visible).toBe(false);

    const shown = reduceNavProgress(running, { type: "show" });
    expect(shown.visible).toBe(true);

    const ticked = reduceNavProgress(shown, { type: "tick", elapsedMs: 200 });
    expect(ticked.value).toBeGreaterThan(shown.value);

    const committed = reduceNavProgress(ticked, { type: "commit" });
    expect(committed.phase).toBe("settling");
    expect(committed.value).toBe(1);
    expect(committed.visible).toBe(true);

    expect(reduceNavProgress(committed, { type: "reset" })).toBe(NAV_PROGRESS_IDLE);
  });

  test("a second click does not restart the timeline", () => {
    const running = run([{ type: "start" }, { type: "show" }, { type: "tick", elapsedMs: 800 }]);
    expect(reduceNavProgress(running, { type: "start" })).toBe(running);
  });

  test("late timer actions cannot resurrect a settled bar", () => {
    const settled = run([{ type: "start" }, { type: "commit" }]);
    expect(reduceNavProgress(settled, { type: "tick", elapsedMs: 200 })).toBe(settled);
    expect(reduceNavProgress(settled, { type: "show" })).toBe(settled);
    expect(reduceNavProgress(NAV_PROGRESS_IDLE, { type: "commit" })).toBe(NAV_PROGRESS_IDLE);
    expect(reduceNavProgress(NAV_PROGRESS_IDLE, { type: "tick", elapsedMs: 200 })).toBe(
      NAV_PROGRESS_IDLE,
    );
  });

  test("a navigation that beats the show delay never paints", () => {
    const committed = run([{ type: "start" }, { type: "commit" }]);
    expect(committed.phase).toBe("settling");
    expect(committed.visible).toBe(false);
  });

  test("a navigation that never ticked fades instead of claiming completion", () => {
    const committed = run([{ type: "start" }, { type: "show" }, { type: "commit" }]);
    expect(committed.value).toBe(NAV_PROGRESS_TIMING.start);

    const waited = run([
      { type: "start" },
      { type: "show" },
      { type: "tick", elapsedMs: 200 },
      { type: "commit" },
    ]);
    expect(waited.value).toBe(1);
  });

  test("stalls once, and only while running", () => {
    const running = run([{ type: "start" }, { type: "stall" }]);
    expect(running.stalled).toBe(true);
    expect(reduceNavProgress(running, { type: "stall" })).toBe(running);
    expect(reduceNavProgress(NAV_PROGRESS_IDLE, { type: "stall" })).toBe(NAV_PROGRESS_IDLE);

    const committed = reduceNavProgress(running, { type: "commit" });
    expect(committed.stalled).toBe(false);
  });
});

describe("startNavProgress", () => {
  test("broadcasts a start to every subscriber until it unsubscribes", () => {
    const seen: NavProgressAction[] = [];
    const off = subscribeNavProgress((action) => seen.push(action));
    const other = subscribeNavProgress((action) => seen.push(action));

    startNavProgress();
    expect(seen).toEqual([{ type: "start" }, { type: "start" }]);

    off();
    other();
    startNavProgress();
    expect(seen).toHaveLength(2);
  });
});
