"use client";

import { useEffect, useState } from "react";

/**
 * `false` during SSR and the first client render, `true` once React has taken over.
 *
 * A page-level `<form onSubmit>` is a trap before hydration: React has not attached the
 * handler yet, so the browser falls back to a native submit. With no `action` that is a GET
 * to the current URL, which drags every field — a password included — into the address bar,
 * the `Referer` and the access log. Gating the submit control on this closes that window
 * while keeping `type="submit"`, so Enter-key submission and the browser's own affordances
 * still work after hydration.
 *
 * The un-hydrated page also needs a plain `<noscript>` note; a disabled button on its own
 * reads as a broken page rather than a loading one.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}

/**
 * `true` when hydration is still outstanding after `timeoutMs`.
 *
 * Hydration normally lands in a few hundred milliseconds, but it has one silent failure mode:
 * an async chunk that never arrives. A failed `<script>` is not retried, so React never boots
 * and every hydration-gated control stays disabled — which looks exactly like a hung request.
 * That happens when a dev-server restart rotates every chunk hash under an already-open tab
 * (the old `/_next/static/chunks/*` 404s), or when a proxy/CDN answers those URLs with
 * something that is not the script. This is what lets the form say so instead of spinning.
 *
 * Callers gate on `!hydrated` as well; once `hydrated` flips, the timer is dropped.
 */
export function useHydrationStalled(hydrated: boolean, timeoutMs = 8000): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (hydrated) return;
    const timer = setTimeout(() => setStalled(true), timeoutMs);
    return () => clearTimeout(timer);
  }, [hydrated, timeoutMs]);
  return stalled;
}
