import { cookies } from "next/headers";

import { getDb } from "@/db/client";
import { getCookieShape } from "@/lib/settings/runtime";

/**
 * Admin sessions use their own cookie. A forum session and an admin session are different
 * identities (decisions/2026-10-25-admin-local-identity.md), so they must never be
 * interchangeable — not even by accident in a shared helper.
 *
 * Name and `Secure` follow the effective public URL (`lib/settings/runtime.ts`), same as the
 * forum session: switching the store to https moves both sides in the same request.
 */

export async function setAdminSessionCookie(
  value: string,
  expiresAt: Date,
): Promise<void> {
  const shape = await getCookieShape(getDb());
  const store = await cookies();
  store.set(shape.name("admin_session"), value, {
    httpOnly: true,
    secure: shape.secure,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function readAdminSessionCookie(): Promise<string | null> {
  const shape = await getCookieShape(getDb());
  const store = await cookies();
  return store.get(shape.name("admin_session"))?.value ?? null;
}

export async function clearAdminSessionCookie(): Promise<void> {
  const shape = await getCookieShape(getDb());
  const store = await cookies();
  store.set(shape.name("admin_session"), "", {
    httpOnly: true,
    secure: shape.secure,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
