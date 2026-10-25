import { cookies } from "next/headers";

import { getDb } from "@/db/client";
import { getCookieShape } from "@/lib/settings/runtime";

/**
 * Forum-session cookies.
 *
 * The name and the `Secure` flag come from the effective public URL, not from the boot-time
 * env seed: an operator who switches the store to https in the console expects the cookie
 * shape to follow in the same request, and `lib/settings/runtime.ts` is the only place that
 * knows which URL is in effect.
 */

export async function setStateCookie(
  value: string,
  maxAgeSeconds: number,
): Promise<void> {
  const shape = await getCookieShape(getDb());
  const store = await cookies();
  store.set(shape.name("oauth_state"), value, {
    httpOnly: true,
    secure: shape.secure,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

export async function readStateCookie(): Promise<string | null> {
  const shape = await getCookieShape(getDb());
  const store = await cookies();
  return store.get(shape.name("oauth_state"))?.value ?? null;
}

export async function clearStateCookie(): Promise<void> {
  const shape = await getCookieShape(getDb());
  const store = await cookies();
  store.set(shape.name("oauth_state"), "", {
    httpOnly: true,
    secure: shape.secure,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function setSessionCookie(
  value: string,
  expiresAt: Date,
): Promise<void> {
  const shape = await getCookieShape(getDb());
  const store = await cookies();
  store.set(shape.name("session"), value, {
    httpOnly: true,
    secure: shape.secure,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function readSessionCookie(): Promise<string | null> {
  const shape = await getCookieShape(getDb());
  const store = await cookies();
  return store.get(shape.name("session"))?.value ?? null;
}

export async function clearSessionCookie(): Promise<void> {
  const shape = await getCookieShape(getDb());
  const store = await cookies();
  store.set(shape.name("session"), "", {
    httpOnly: true,
    secure: shape.secure,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function setGithubInstallCookie(
  value: string,
  maxAgeSeconds: number,
): Promise<void> {
  const shape = await getCookieShape(getDb());
  const store = await cookies();
  store.set(shape.name("github_install"), value, {
    httpOnly: true,
    secure: shape.secure,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

export async function readGithubInstallCookie(): Promise<string | null> {
  const shape = await getCookieShape(getDb());
  const store = await cookies();
  return store.get(shape.name("github_install"))?.value ?? null;
}

export async function clearGithubInstallCookie(): Promise<void> {
  const shape = await getCookieShape(getDb());
  const store = await cookies();
  store.set(shape.name("github_install"), "", {
    httpOnly: true,
    secure: shape.secure,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/**
 * The manifest handshake's state, kept in a cookie for the same reason the install state is:
 * it is one short-lived value that must survive a round trip through github.com and nothing
 * else. It carries the admin id, so the callback cannot be completed by another session.
 */
export async function setGithubManifestCookie(
  value: string,
  maxAgeSeconds: number,
): Promise<void> {
  const shape = await getCookieShape(getDb());
  const store = await cookies();
  store.set(shape.name("github_manifest"), value, {
    httpOnly: true,
    secure: shape.secure,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

export async function readGithubManifestCookie(): Promise<string | null> {
  const shape = await getCookieShape(getDb());
  const store = await cookies();
  return store.get(shape.name("github_manifest"))?.value ?? null;
}

export async function clearGithubManifestCookie(): Promise<void> {
  const shape = await getCookieShape(getDb());
  const store = await cookies();
  store.set(shape.name("github_manifest"), "", {
    httpOnly: true,
    secure: shape.secure,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
