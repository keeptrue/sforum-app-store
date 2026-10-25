import type { Db } from "@/db/client";
import { readAdminSessionCookie } from "@/lib/admin/cookies";
import { findAdminSession, type CurrentAdminSession } from "@/lib/admin/session";
import { isSameOrigin, jsonError } from "@/lib/auth/http";
import { getRuntimeConfig } from "@/lib/settings/runtime";

/**
 * Admin authorisation.
 *
 * Two shapes on purpose:
 * - `authorizeAdminRequest` for route handlers — 401 before any lookup, 403 once we know the
 *   caller is authenticated, and a cross-origin mutation is rejected before the session read.
 * - `getAdminSession` for server components — the page decides between "redirect to login"
 *   and `notFound()`.
 */

export type AdminAuth =
  | { ok: true; session: CurrentAdminSession }
  | { ok: false; response: Response };

export async function getAdminSession(db: Db): Promise<CurrentAdminSession | null> {
  const token = await readAdminSessionCookie();
  if (!token) return null;
  return findAdminSession(db, token);
}

export async function authorizeAdminRequest(
  db: Db,
  request: Request,
  options: { mutation: boolean },
): Promise<AdminAuth> {
  // The effective public URL, not the boot seed: the console is the page that changes it.
  const { publicUrl } = await getRuntimeConfig(db);
  if (options.mutation && !isSameOrigin(request, publicUrl)) {
    return { ok: false, response: jsonError("cross_origin", 403) };
  }

  const session = await getAdminSession(db);
  if (!session) {
    return { ok: false, response: jsonError("unauthenticated", 401) };
  }

  return { ok: true, session };
}
