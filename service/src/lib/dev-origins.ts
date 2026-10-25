/**
 * Hosts allowed to reach the Next.js dev server cross-origin.
 *
 * `next dev` runs `blockCrossSiteDEV` over `/_next/*` and `/__nextjs*`: a request whose
 * `Origin` hostname is not on the allowlist is answered with a bare 403. That silently kills
 * the HMR socket and the error overlay, so a page loaded through a reverse proxy or a tunnel
 * looks alive but reports nothing when something breaks.
 *
 * The loopback hosts cover the normal case. Anything else has to be listed explicitly —
 * deriving it from `X-Forwarded-Host` or the `Host` header would trust a value the caller
 * controls. `STORE_DEV_ORIGINS` (comma separated, `*` subdomain wildcards allowed) exists so
 * a rotating tunnel hostname does not require a code change.
 */
const LOOPBACK_HOSTS = ["127.0.0.1", "[::1]", "::1"];

export function resolveAllowedDevOrigins(raw?: string): string[] {
  const extra = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...LOOPBACK_HOSTS, ...extra];
}
