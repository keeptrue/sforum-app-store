import { getDb } from "@/db/client";
import { jsonError, routeError } from "@/lib/auth/http";
import type { GithubConfig } from "@/lib/config";
import {
  GithubAppConfigError,
  requireGithubConfig,
} from "@/lib/github/app-config";
import {
  markWebhookDelivery,
  recordWebhookDelivery,
} from "@/lib/github/deliveries";
import { pushTouchesBrand, type PushPayload } from "@/lib/github/push-filter";
import { verifyGithubSignature } from "@/lib/github/webhook";
import { enqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const db = getDb();
    // The webhook secret comes from the console, not env: an unconfigured or unreadable App
    // must answer 503 instead of verifying against nothing.
    let github: GithubConfig;
    try {
      github = await requireGithubConfig(db);
    } catch (error) {
      if (error instanceof GithubAppConfigError) {
        return jsonError(error.code, 503, error.message);
      }
      throw error;
    }

    const raw = Buffer.from(await request.arrayBuffer());
    if (raw.length > 5 * 1024 * 1024) {
      return jsonError("payload_too_large", 413);
    }
    const signature = request.headers.get("x-hub-signature-256");
    if (!verifyGithubSignature(raw, signature, github.webhookSecret)) {
      return jsonError("invalid_signature", 401);
    }

    const event = request.headers.get("x-github-event");
    const deliveryId = request.headers.get("x-github-delivery");
    if (!event || !deliveryId) {
      return jsonError("missing_headers", 400);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      return jsonError("invalid_json", 400);
    }

    // `push` is subscribed only to notice `brand/` edits. Everything else about a push is
    // noise the store would pay storage for and never read, so the filter runs before the
    // delivery row exists. A retry of a filtered delivery re-evaluates the same payload and
    // is ignored again, so idempotency does not depend on that row.
    if (event === "push" && !pushTouchesBrand(payload as PushPayload)) {
      return Response.json(
        { ok: true, ignored: "push_not_brand" },
        { status: 202, headers: { "Cache-Control": "no-store" } },
      );
    }

    const isNew = await recordWebhookDelivery(db, {
      deliveryId,
      event,
      action: typeof payload.action === "string" ? payload.action : null,
      payload,
    });
    if (!isNew) {
      return Response.json(
        { ok: true, duplicate: true },
        { status: 202, headers: { "Cache-Control": "no-store" } },
      );
    }

    try {
      await enqueue("github-webhook", { deliveryId, event, payload });
    } catch (error) {
      await markWebhookDelivery(
        db,
        deliveryId,
        "failed",
        error instanceof Error ? error.message : "enqueue_failed",
      );
      return jsonError("queue_unavailable", 503);
    }

    return Response.json(
      { ok: true },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}
