import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { query, transaction } from '@autoflow/database';
import { encryptText } from '@autoflow/security';
import { AppError } from '@autoflow/shared';
import { authenticateApiKey } from '../auth/api-key-middleware.js';
import type { ApiKeyRequest } from '../types.js';

const sendSchema = z.object({
  instanceId: z.uuid(),
  contactId: z.uuid().optional(),
  phoneNumber: z.string().regex(/^[1-9][0-9]{9,14}$/).optional(),
  text: z.string().min(1).max(4096).refine((text) => text.trim().length > 0),
  idempotencyKey: z.string().trim().min(8).max(160).optional(),
}).refine((input) => Boolean(input.contactId) !== Boolean(input.phoneNumber), {
  message: 'Informe contactId ou phoneNumber (numero internacional somente com digitos).',
});

const router: Router = Router();

router.post('/', authenticateApiKey('messages:write'), async (req, res, next) => {
  try {
    const input = sendSchema.parse(req.body);
    const auth = (req as ApiKeyRequest).apiAuth;
    const suppliedKey = input.idempotencyKey ?? String(req.headers['idempotency-key'] ?? '');
    if (suppliedKey.length < 8) throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Informe Idempotency-Key com ao menos 8 caracteres.', 422);
    const idempotencyKey = createHash('sha256').update(`${auth.tenantId}:${suppliedKey}`).digest('hex');
    const encrypted = encryptText(input.text);

    const message = await transaction(async (client) => {
      const existing = await client.query<{ id: string; status: string; instance_id: string }>(
        'SELECT id, status, instance_id FROM messages WHERE tenant_id = $1 AND idempotency_key = $2',
        [auth.tenantId, idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].instance_id !== input.instanceId) {
          throw new AppError('IDEMPOTENCY_CONFLICT', 'A chave de idempotencia ja foi usada com outro envio.', 409);
        }
        return existing.rows[0];
      }

      const target = await client.query<{ id: string; phone_number: string }>(
        `SELECT ct.id, ct.phone_number
         FROM contacts ct
         JOIN whatsapp_instances i ON i.tenant_id = ct.tenant_id
         WHERE (($1::uuid IS NOT NULL AND ct.id = $1::uuid)
             OR ($4::text IS NOT NULL AND ct.phone_number = $4))
           AND ct.tenant_id = $2 AND i.id = $3
           AND ct.deleted_at IS NULL AND ct.consent_status = 'GRANTED'
           AND ct.opted_out_at IS NULL AND ct.blocked_at IS NULL
           AND i.deleted_at IS NULL AND i.sending_enabled = true`,
        [input.contactId ?? null, auth.tenantId, input.instanceId, input.phoneNumber ?? null],
      );
      if (!target.rows[0]) {
        throw new AppError('TARGET_NOT_ELIGIBLE', 'Contato sem consentimento ou instancia indisponivel.', 409);
      }
      if (target.rows.length !== 1) {
        throw new AppError('AMBIGUOUS_CONTACT', 'Mais de um contato encontrado para este numero.', 409);
      }

      const inserted = await client.query<{ id: string; status: string; instance_id: string }>(
        `INSERT INTO messages
           (tenant_id, instance_id, contact_id, direction, type, status,
            content_ciphertext, content_iv, content_tag, idempotency_key, recipient_phone_snapshot)
         VALUES ($1, $2, $3, 'OUTBOUND', 'TEXT', 'QUEUED', $4, $5, $6, $7, $8)
         RETURNING id, status, instance_id`,
        [auth.tenantId, input.instanceId, target.rows[0].id, encrypted.ciphertext, encrypted.iv, encrypted.tag, idempotencyKey, target.rows[0].phone_number],
      );
      return inserted.rows[0]!;
    });

    res.status(message.status === 'QUEUED' ? 202 : 200).json({ id: message.id, status: message.status });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', authenticateApiKey('messages:read'), async (req, res, next) => {
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
