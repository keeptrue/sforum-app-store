import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { readSessionCookie } from "@/lib/auth/cookies";
import { isSameOrigin } from "@/lib/auth/http";
import { findSession } from "@/lib/auth/service";
import { decideAuthRequest } from "@/lib/install-auth/service";
import { getRuntimeConfig } from "@/lib/settings/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The approval form's only writer.
 *
 * Three gates, in this order: same-origin (a cross-site POST cannot approve a request the
 * attacker started), a forum session (the account is the point of the whole flow), and a
 * conditional state transition inside `decideAuthRequest` (an expired or already-decided
 * request cannot be flipped). The answer is a 303 back to the receipt page, so a refresh does
 * not re-submit.
 */
export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { id } = await context.params;
  const db = getDb();
  const { publicUrl } = await getRuntimeConfig(db);

  if (!isSameOrigin(request, publicUrl)) {
    return NextResponse.json(
      { code: "origin_mismatch", message: "origin_mismatch" },
      { status: 403, headers: NO_STORE },
    );
  }

  const sessionToken = await readSessionCookie();
  const session = sessionToken ? await findSession(db, sessionToken) : null;
  if (!session) {
    // Not an error: the operator may simply have opened the page after their session expired.
    // Send them through the forum login and back to this exact request.
    return NextResponse.redirect(
      new URL(
        `/api/auth/sforum/start?redirect=${encodeURIComponent(`/connect/${id}`)}`,
        publicUrl,
      ),
      303,
    );
  }

  const form = await request.formData().catch(() => null);
  const decision = form?.get("decision");
  if (decision !== "approve" && decision !== "deny") {
    return NextResponse.json(
      { code: "invalid_decision", message: "invalid_decision" },
      { status: 400, headers: NO_STORE },
    );
  }

  const outcome = await decideAuthRequest(
    db,
    id,
    session.account.id,
    decision === "approve" ? "approve" : "deny",
  );

  // `not_pending` is not a failure to report as an error: the receipt page re-reads the row
  // and explains what actually happened (consumed / denied / expired).
  const done =
    outcome === "approved" || outcome === "denied" || outcome === "expired"
      ? outcome
      : "not_pending";

  return NextResponse.redirect(
    new URL(`/connect/${id}?done=${done}`, publicUrl),
    303,
  );
}
