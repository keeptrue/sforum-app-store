import type { NextConfig } from "next";

import { resolveAllowedDevOrigins } from "./src/lib/dev-origins";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // `next dev` announces itself as `localhost`, so a page opened at 127.0.0.1 is
  // cross-origin for Next's dev-only endpoints (`/_next/hmr`, `/__nextjs_*`). Next
  // answers those with 403, the dev client never finishes booting, and React never
  // hydrates: the page renders (SSR) but every client component is inert.
  //
  // A tunnel or reverse proxy puts a third hostname in front of the same process, which
  // needs the same treatment. It cannot be inferred from the request without trusting a
  // spoofable header, so it comes from `STORE_DEV_ORIGINS` (comma separated, wildcards
  // allowed) — see `src/lib/dev-origins.ts`.
  allowedDevOrigins: resolveAllowedDevOrigins(process.env.STORE_DEV_ORIGINS),
};

export default nextConfig;
