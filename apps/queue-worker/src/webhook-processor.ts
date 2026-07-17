import type { Job } from 'bullmq';
import { query } from '@autoflow/database';
import { webhookDeliveryJobSchema, type WebhookDeliveryJob } from '@autoflow/queue';
import { decryptText, signWebhook } from '@autoflow/security';
import { AppError } from '@autoflow/shared';

interface DeliveryRow {
  id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  attempt: number;
  url: string;
  secret_ciphertext: Buffer;
  secret_iv: Buffer;
  secret_tag: Buffer;
}

export async function processWebhookDelivery(job: Job<WebhookDeliveryJob>): Promise<void> {
  const input = webhookDeliveryJobSchema.parse(job.data);
  const rows = await query<DeliveryRow>(
    `UPDATE webhook_deliveries d SET status = 'PROCESSING', attempt = attempt + 1
     FROM webhook_endpoints e
     WHERE d.id = $1 AND d.tenant_id = $2
       AND e.id = d.webhook_endpoint_id AND e.tenant_id = d.tenant_id
       AND e.status = 'ACTIVE' AND d.status IN ('PENDING', 'RETRYING', 'FAILED')
     RETURNING d.id, d.event_id, d.event_type, d.payload, d.attempt,
               e.url, e.secret_ciphertext, e.secret_iv, e.secret_tag`,
    [input.deliveryId, input.tenantId],
  );
  const delivery = rows[0];
  if (!delivery) throw new AppError('WEBHOOK_DELIVERY_NOT_FOUND', 'Entrega de webhook nao encontrada.', 404);

  const body = JSON.stringify({
    id: delivery.event_id,
    type: delivery.event_type,
    createdAt: new Date().toISOString(),
    tenantId: input.tenantId,
    data: delivery.payload,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = decryptText({
    ciphertext: delivery.secret_ciphertext,
    iv: delivery.secret_iv,
    tag: delivery.secret_tag,
  });
  let response: Response;
  try {
    response = await fetch(delivery.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-id': delivery.event_id,
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': signWebhook(body, timestamp, secret),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    await query(
      `UPDATE webhook_deliveries SET status = 'RETRYING', response_status = NULL,
              response_body_summary = $2, next_attempt_at = now() + (LEAST(3600, 5 * power(2, attempt)) * interval '1 second')
       WHERE id = $1`,
      [delivery.id, error instanceof Error ? error.message.slice(0, 1000) : 'Falha de rede'],
    );
    throw error;
  }
  const responseBody = (await response.text()).slice(0, 1000);
  if (!response.ok) {
    await query(
      `UPDATE webhook_deliveries SET status = 'RETRYING', response_status = $2,
              response_body_summary = $3, next_attempt_at = now() + (LEAST(3600, 5 * power(2, attempt)) * interval '1 second')
       WHERE id = $1`,
      [delivery.id, response.status, responseBody],
    );
    throw new AppError('WEBHOOK_REJECTED', `Webhook respondeu HTTP ${response.status}.`, 502);
  }
  await query(
    `UPDATE webhook_deliveries SET status = 'DELIVERED', response_status = $2,
            response_body_summary = $3, delivered_at = now(), next_attempt_at = NULL
     WHERE id = $1`,
    [delivery.id, response.status, responseBody],
  );
  await query(
    `UPDATE webhook_endpoints SET consecutive_failures = 0, updated_at = now()
     WHERE id = (SELECT webhook_endpoint_id FROM webhook_deliveries WHERE id = $1)`,
    [delivery.id],
  );
}
