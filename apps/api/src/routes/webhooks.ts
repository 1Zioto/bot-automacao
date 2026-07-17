import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { getEnvironment } from '@autoflow/config';
import { query } from '@autoflow/database';
import { webhookEventTypes } from '@autoflow/events';
import { createQueue, queueNames, type WebhookDeliveryJob } from '@autoflow/queue';
import { createWebhookSecret, encryptText } from '@autoflow/security';
import { AppError } from '@autoflow/shared';
import { recordAudit } from '../audit.js';
import { authenticate, requirePermission } from '../auth/middleware.js';
import type { AuthenticatedRequest } from '../types.js';

const eventSchema = z.enum(webhookEventTypes);
const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  url: z.url(),
  subscribedEvents: z.array(eventSchema).min(1),
});
const deliveryQueue = createQueue<WebhookDeliveryJob>(queueNames.webhookDeliveries);
const router: Router = Router();
router.use(authenticate, requirePermission('integrations.manage'));

router.get('/', async (req, res, next) => {
  try {
    const auth = (req as unknown as AuthenticatedRequest).auth;
    const rows = await query(
      `SELECT id, name, url, subscribed_events, status, consecutive_failures, created_at, updated_at
       FROM webhook_endpoints WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [auth.tenantId],
    );
    res.json({ data: rows });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body);
    const auth = (req as unknown as AuthenticatedRequest).auth;
    const url = new URL(input.url);
    if (getEnvironment().NODE_ENV === 'production' && url.protocol !== 'https:') throw new AppError('HTTPS_REQUIRED', 'Webhooks exigem HTTPS em producao.', 400);
    const plan = await query<{ webhooks_enabled: boolean }>(
      `SELECT p.webhooks_enabled FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.tenant_id = $1 AND s.status IN ('TRIALING', 'ACTIVE', 'GRACE_PERIOD')`,
      [auth.tenantId],
    );
    if (!plan[0]?.webhooks_enabled) throw new AppError('WEBHOOKS_NOT_INCLUDED', 'Webhooks nao incluidos no plano.', 403);
    const secret = createWebhookSecret();
    const encrypted = encryptText(secret);
    const rows = await query<{ id: string; name: string; url: string; subscribed_events: string[]; status: string }>(
      `INSERT INTO webhook_endpoints
         (tenant_id, name, url, secret_ciphertext, secret_iv, secret_tag, subscribed_events)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[])
       RETURNING id, name, url, subscribed_events, status`,
      [auth.tenantId, input.name, input.url, encrypted.ciphertext, encrypted.iv, encrypted.tag, input.subscribedEvents],
    );
    await recordAudit(req, { action: 'webhook.created', entityType: 'WebhookEndpoint', entityId: rows[0]!.id, newValues: { name: input.name, url: input.url, events: input.subscribedEvents } });
    res.status(201).json({ ...rows[0], secret });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/test', async (req, res, next) => {
  try {
    const auth = (req as unknown as AuthenticatedRequest).auth;
    const eventId = randomUUID();
    const rows = await query<{ id: string }>(
      `INSERT INTO webhook_deliveries
         (tenant_id, webhook_endpoint_id, event_id, event_type, payload)
       SELECT $1, id, $3, 'webhook.test', $4::jsonb
       FROM webhook_endpoints WHERE id = $2 AND tenant_id = $1 AND status = 'ACTIVE'
       RETURNING id`,
      [auth.tenantId, req.params.id, eventId, JSON.stringify({ test: true })],
    );
    if (!rows[0]) throw new AppError('WEBHOOK_NOT_FOUND', 'Webhook nao encontrado.', 404);
    await deliveryQueue.add('deliver', { tenantId: auth.tenantId, deliveryId: rows[0].id }, { jobId: `webhook-${rows[0].id}` });
    res.status(202).json({ deliveryId: rows[0].id, eventId });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/deliveries', async (req, res, next) => {
  try {
    const auth = (req as unknown as AuthenticatedRequest).auth;
    const rows = await query(
      `SELECT id, event_id, event_type, attempt, status, response_status,
              response_body_summary, next_attempt_at, delivered_at, created_at
       FROM webhook_deliveries
       WHERE tenant_id = $1 AND webhook_endpoint_id = $2
       ORDER BY created_at DESC LIMIT 100`,
      [auth.tenantId, req.params.id],
    );
    res.json({ data: rows });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/deliveries/:deliveryId/retry', async (req, res, next) => {
  try {
    const auth = (req as unknown as AuthenticatedRequest).auth;
    const rows = await query<{ id: string }>(
      `UPDATE webhook_deliveries SET status = 'RETRYING', next_attempt_at = now()
       WHERE id = $1 AND webhook_endpoint_id = $2 AND tenant_id = $3 AND status = 'FAILED'
       RETURNING id`,
      [req.params.deliveryId, req.params.id, auth.tenantId],
    );
    if (!rows[0]) throw new AppError('DELIVERY_NOT_RETRYABLE', 'Entrega nao encontrada ou nao pode ser repetida.', 409);
    await deliveryQueue.add('deliver', { tenantId: auth.tenantId, deliveryId: rows[0].id }, { jobId: `webhook-retry-${rows[0].id}-${Date.now()}` });
    res.status(202).json({ deliveryId: rows[0].id });
  } catch (error) {
    next(error);
  }
});

export { router as webhooksRouter };
