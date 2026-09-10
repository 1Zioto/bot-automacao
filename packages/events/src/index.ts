import { randomUUID } from 'node:crypto';
import { query } from '@autoflow/database';
import { createQueue, queueNames, type WebhookDeliveryJob } from '@autoflow/queue';

export const webhookEventTypes = [
  'instance.created', 'instance.qr_updated', 'instance.ready', 'instance.disconnected', 'instance.error',
  'campaign.created', 'campaign.started', 'campaign.paused', 'campaign.resumed', 'campaign.completed', 'campaign.canceled',
  'message.queued', 'message.sent', 'message.delivered', 'message.read', 'message.failed', 'message.received',
  'contact.opted_out', 'usage.daily_limit_reached',
] as const;
export type WebhookEventType = (typeof webhookEventTypes)[number];

const deliveryQueue = createQueue<WebhookDeliveryJob>(queueNames.webhookDeliveries);

export async function emitWebhookEvent(tenantId: string, eventType: WebhookEventType, data: unknown): Promise<string> {
  const eventId = randomUUID();
  const deliveries = await query<{ id: string }>(
    `INSERT INTO webhook_deliveries
       (tenant_id, webhook_endpoint_id, event_id, event_type, payload)
     SELECT $1, e.id, $2, $3, $4::jsonb
     FROM webhook_endpoints e
     WHERE e.tenant_id = $1 AND e.status = 'ACTIVE' AND $3 = ANY(e.subscribed_events)
     RETURNING id`,
    [tenantId, eventId, eventType, JSON.stringify(data)],
  );
  if (deliveries.length > 0) {
    try {
      await deliveryQueue.addBulk(deliveries.map((delivery) => ({
        name: 'deliver',
        data: { tenantId, deliveryId: delivery.id },
        opts: { jobId: `webhook-${delivery.id}` },
      })));
    } catch {
      // Redis opcional
    }
  }
  return eventId;
}
