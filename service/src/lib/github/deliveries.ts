import { eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import { webhookDeliveries } from "@/db/schema";

export type WebhookDeliveryInput = {
  deliveryId: string;
  event: string;
  action?: string | null;
  payload: Record<string, unknown>;
};

/**
 * Returns true when the delivery is new, false when it was already recorded.
 * The primary key is the GitHub delivery id, which is what makes retries
 * idempotent.
 */
export async function recordWebhookDelivery(
  db: Db,
  input: WebhookDeliveryInput,
): Promise<boolean> {
  const inserted = await db
    .insert(webhookDeliveries)
    .values({
      deliveryId: input.deliveryId,
      event: input.event,
      action: input.action ?? null,
      payload: input.payload,
    })
    .onConflictDoNothing()
    .returning({ deliveryId: webhookDeliveries.deliveryId });
  return inserted.length > 0;
}

export async function markWebhookDelivery(
  db: Db,
  deliveryId: string,
  status: "processed" | "failed",
  error?: string | null,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({
      status,
      error: error ?? null,
      processedAt: new Date(),
    })
    .where(eq(webhookDeliveries.deliveryId, deliveryId));
}
