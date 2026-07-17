import { createHash } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { getPool, query } from '@autoflow/database';
import { createQueue, queueNames, type DirectOutboundMessageJob } from '@autoflow/queue';
import { encryptText } from '@autoflow/security';
import { AppError } from '@autoflow/shared';
import { authenticateApiKey } from '../auth/api-key-middleware.js';
import { emitEventSafely } from '../events.js';
import type { ApiKeyRequest } from '../types.js';

const sendSchema = z.object({
  instanceId: z.uuid(),
  contactId: z.uuid(),
  text: z.string().trim().min(1).max(4096),
  idempotencyKey: z.string().trim().min(8).max(160).optional(),
});
const directQueue = createQueue<DirectOutboundMessageJob>(queueNames.directOutboundMessages);
const apiKeyRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => (req as ApiKeyRequest).apiAuth.apiKeyId,
});
const router: Router = Router();

router.post('/', authenticateApiKey('messages:write'), apiKeyRateLimit, async (req, res, next) => {
  try {
    const input = sendSchema.parse(req.body);
    const auth = (req as ApiKeyRequest).apiAuth;
    const suppliedKey = input.idempotencyKey ?? String(req.headers['idempotency-key'] ?? '');
    if (suppliedKey.length < 8) throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Informe Idempotency-Key com ao menos 8 caracteres.', 422);
    const idempotencyKey = createHash('sha256').update(`${auth.tenantId}:${suppliedKey}`).digest('hex');
    const encrypted = encryptText(input.text);
    const client = await getPool().connect();
    let message: { id: string; status: string; instance_id: string };
    let created = false;
    try {
      await client.query('BEGIN');
      const existing = await client.query<{ id: string; status: string; instance_id: string }>(
        'SELECT id, status, instance_id FROM messages WHERE tenant_id = $1 AND idempotency_key = $2',
        [auth.tenantId, idempotencyKey],
      );
      if (existing.rows[0]) {
        message = existing.rows[0];
        if (message.instance_id !== input.instanceId) throw new AppError('IDEMPOTENCY_CONFLICT', 'A chave de idempotencia ja foi usada com outro envio.', 409);
      } else {
        const target = await client.query<{ phone_number: string }>(
          `SELECT ct.phone_number
           FROM contacts ct
           JOIN whatsapp_instances i ON i.tenant_id = ct.tenant_id
           WHERE ct.id = $1 AND ct.tenant_id = $2 AND i.id = $3
             AND ct.deleted_at IS NULL AND ct.consent_status = 'GRANTED'
             AND ct.opted_out_at IS NULL AND ct.blocked_at IS NULL
             AND i.deleted_at IS NULL AND i.sending_enabled = true`,
          [input.contactId, auth.tenantId, input.instanceId],
        );
        if (!target.rows[0]) throw new AppError('TARGET_NOT_ELIGIBLE', 'Contato sem consentimento ou instancia indisponivel.', 409);
        const inserted = await client.query<{ id: string; status: string; instance_id: string }>(
          `INSERT INTO messages
             (tenant_id, instance_id, contact_id, direction, type, status,
              content_ciphertext, content_iv, content_tag, idempotency_key, recipient_phone_snapshot)
           VALUES ($1, $2, $3, 'OUTBOUND', 'TEXT', 'QUEUED', $4, $5, $6, $7, $8)
           RETURNING id, status, instance_id`,
          [auth.tenantId, input.instanceId, input.contactId, encrypted.ciphertext, encrypted.iv, encrypted.tag, idempotencyKey, target.rows[0].phone_number],
        );
        message = inserted.rows[0]!;
        created = true;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (['QUEUED', 'FAILED'].includes(message.status)) {
      await directQueue.add(
        'send-direct',
        { tenantId: auth.tenantId, instanceId: message.instance_id, messageId: message.id, idempotencyKey },
        { jobId: `direct-${idempotencyKey}` },
      );
    }
    if (created) await emitEventSafely(auth.tenantId, 'message.queued', { id: message.id, instanceId: message.instance_id, contactId: input.contactId });
    res.status(message.status === 'QUEUED' ? 202 : 200).json({ id: message.id, status: message.status });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', authenticateApiKey('messages:read'), apiKeyRateLimit, async (req, res, next) => {
  try {
    const auth = (req as unknown as ApiKeyRequest).apiAuth;
    const rows = await query(
      `SELECT id, instance_id, contact_id, direction, type, status, external_message_id,
              sent_at, delivered_at, read_at, error_code, created_at
       FROM messages WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, auth.tenantId],
    );
    if (!rows[0]) throw new AppError('MESSAGE_NOT_FOUND', 'Mensagem nao encontrada.', 404);
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

export { router as messagesRouter };
