import { cache } from "react";
import { notFound, redirect } from "next/navigation";

import { getDb } from "@/db/client";
import { readSessionCookie } from "@/lib/auth/cookies";
import { findSession, type CurrentSession } from "@/lib/auth/service";

/**
 * The request's session, memoised.
 *
 * Layout and page both ask for it on the developer portal (chrome needs the roles, the page
 * needs the account), and `cache` keeps that one cookie + one Postgres lookup per request
 * instead of two. Never a gate by itself — see `requireDashboardSession`.
 */
export const readConsoleSession = cache(async (): Promise<CurrentSession | null> => {
  const token = await readSessionCookie();
  return token ? findSession(getDb(), token) : null;
});

/**
 * Server-side session gate for the developer portal.
 *
 * The session lives in Postgres and is read from the HttpOnly cookie, so a page can answer
 * "who owns these products" without a client round trip. No session means the OAuth flow,
 * not an empty dashboard.
 */
export async function requireDashboardSession(): Promise<CurrentSession> {
  const session = await readConsoleSession();
  if (!session) redirect("/api/auth/sforum/start?redirect=/dashboard");
  return session;
}

/** The rail's `审核台` entry is the only role-gated link, so this is the whole rule. */
export function canModerate(session: CurrentSession | null): boolean {
  return session?.roles.includes("moderator") ?? false;
}

/**
 * The moderation console's gate: anonymous visitors get the OAuth flow, everyone else
 * without the role gets a 404 — not a 403, which would confirm the console exists
 * (plan §7.4 item 6). Called from the layout (so the chrome never wraps the 404) and again
 * from the page (which needs the reviewer's name); `readConsoleSession` is memoised, so the
 * second call costs nothing.
 */
export async function requireModeratorSession(): Promise<CurrentSession> {
  const session = await readConsoleSession();
  if (!session) redirect("/api/auth/sforum/start?redirect=/moderation");
  // A legacy `store_roles.role='admin'` row grants nothing either
  // (decisions/2026-10-25-admin-local-identity.md).
  if (!canModerate(session)) notFound();
  return session;
}

/** `official#1` style identity chip, useful in the page header and in support requests. */
export function sessionIdentity(session: CurrentSession): string {
  const name = session.account.displayName ?? session.account.username ?? session.account.sub;
  return `${name} · ${session.account.issuerKey}#${session.account.sub}`;
}
