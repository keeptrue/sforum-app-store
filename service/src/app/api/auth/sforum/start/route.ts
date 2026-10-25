import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { setStateCookie } from "@/lib/auth/cookies";
import { routeError, safeRedirect } from "@/lib/auth/http";
import { listActiveIssuers, loadActiveIssuer } from "@/lib/auth/service";
import { encodeState } from "@/lib/auth/state";
import { getConfig } from "@/lib/config";
import { getRuntimeConfig } from "@/lib/settings/runtime";
import { enforceChannelLimit, ipBucket } from "@/lib/ratelimit/enforce";
import { challengeFor, createState, createVerifier } from "@/lib/oauth/pkce";
import { SforumOAuthClient } from "@/lib/oauth/provider";
import { sforumCallbackUrl } from "@/lib/oauth/redirect";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const config = getConfig();
    const db = getDb();
    const { publicUrl } = await getRuntimeConfig(db);

    // Login is the cheapest endpoint to abuse: one counter per IP, before any provider call.
    const limited = await enforceChannelLimit(db, "login", ipBucket(request, "login"));
    if (limited) return limited;

    const url = new URL(request.url);
    const redirectTo = safeRedirect(url.searchParams.get("redirect"));
    const requested = url.searchParams.get("issuer")?.trim() || null;

    // Issuers live in the database now. With none configured the store cannot authenticate
    // anyone, so say so on the storefront instead of failing at the provider.
    const issuers = await listActiveIssuers(db);
    if (issuers.length === 0) {
      return NextResponse.redirect(
        new URL("/?error=no_issuer", publicUrl),
        303,
      );
    }

    // One deployment serves one forum: the admin console refuses a second active issuer and
    // the database enforces it. More than one here means rows predate that invariant, and
    // silently picking one would log users into the wrong forum's account namespace.
    if (issuers.length > 1) {
      return NextResponse.redirect(
        new URL("/?error=multiple_issuers", publicUrl),
        303,
      );
    }

    const active = issuers[0]!;
    // `?issuer=` stays accepted for bookmarked links, but it can no longer select anything:
    // a mismatch is a dead link, not a request to use another forum.
    if (requested && requested !== active.issuerKey) {
      return NextResponse.redirect(
        new URL("/?error=unknown_issuer", publicUrl),
        303,
      );
    }

    const issuer = await loadActiveIssuer(db, config, active.issuerKey);

    const state = createState();
    const verifier = createVerifier();
    const stateCookie = encodeState(
      {
        state,
        verifier,
        issuerKey: issuer.issuerKey,
        redirectTo,
        exp: Math.floor(Date.now() / 1000) + config.stateTtlSeconds,
      },
      config.sessionSecret,
    );
    await setStateCookie(stateCookie, config.stateTtlSeconds);

    const client = new SforumOAuthClient(issuer);
    return NextResponse.redirect(
      client.authorizeUrl({
        redirectUri: sforumCallbackUrl(publicUrl),
        state,
        codeChallenge: challengeFor(verifier),
      }),
    );
  } catch (error) {
    return routeError(error);
  }
}
