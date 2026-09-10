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

      const instance = await client.query<{ id: string; sending_enabled: boolean }>(
        `SELECT id, sending_enabled
         FROM whatsapp_instances
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [input.instanceId, auth.tenantId],
      );
      if (!instance.rows[0]) {
        throw new AppError('INSTANCE_NOT_FOUND', 'Instancia WhatsApp nao encontrada.', 404);
      }
      if (!instance.rows[0].sending_enabled) {
        throw new AppError('INSTANCE_SENDING_DISABLED', 'Instancia WhatsApp desabilitada para envio no painel.', 409);
      }

      let targetContactId: string | null = null;
      let targetPhoneNumber: string;

      if (input.contactId) {
        const ct = await client.query<{ id: string; phone_number: string; blocked_at: Date | null }>(
          `SELECT id, phone_number, blocked_at
           FROM contacts
           WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
          [input.contactId, auth.tenantId],
        );
        if (!ct.rows[0]) {
          throw new AppError('CONTACT_NOT_FOUND', 'Contato nao encontrado.', 404);
        }
        if (ct.rows[0].blocked_at) {
          throw new AppError('CONTACT_BLOCKED', 'Contato esta bloqueado.', 409);
        }
        targetContactId = ct.rows[0].id;
        targetPhoneNumber = ct.rows[0].phone_number;
      } else if (input.phoneNumber) {
        targetPhoneNumber = input.phoneNumber;
        const ct = await client.query<{ id: string; blocked_at: Date | null; consent_status: string }>(
          `SELECT id, blocked_at, consent_status
           FROM contacts
           WHERE tenant_id = $1 AND phone_number = $2 AND deleted_at IS NULL`,
          [auth.tenantId, targetPhoneNumber],
        );
        if (ct.rows[0]) {
          if (ct.rows[0].blocked_at) {
            throw new AppError('CONTACT_BLOCKED', 'Contato esta bloqueado.', 409);
          }
          targetContactId = ct.rows[0].id;
          if (ct.rows[0].consent_status !== 'GRANTED') {
            await client.query(
              `UPDATE contacts SET consent_status = 'GRANTED', consent_source = 'API', updated_at = now() WHERE id = $1`,
              [targetContactId],
            );
          }
        } else {
          const created = await client.query<{ id: string }>(
            `INSERT INTO contacts (tenant_id, name, phone_number, consent_status, consent_source)
             VALUES ($1, $2, $2, 'GRANTED', 'API')
             ON CONFLICT (tenant_id, phone_number) DO UPDATE
             SET deleted_at = NULL, consent_status = 'GRANTED', updated_at = now()
             RETURNING id`,
            [auth.tenantId, targetPhoneNumber],
          );
          targetContactId = created.rows[0]!.id;
        }
      } else {
        throw new AppError('TARGET_REQUIRED', 'Informe contactId ou phoneNumber.', 400);
      }

      const inserted = await client.query<{ id: string; status: string; instance_id: string }>(
        `INSERT INTO messages
           (tenant_id, instance_id, contact_id, direction, type, status,
            content_ciphertext, content_iv, content_tag, idempotency_key, recipient_phone_snapshot)
         VALUES ($1, $2, $3, 'OUTBOUND', 'TEXT', 'QUEUED', $4, $5, $6, $7, $8)
         RETURNING id, status, instance_id`,
        [auth.tenantId, input.instanceId, targetContactId, encrypted.ciphertext, encrypted.iv, encrypted.tag, idempotencyKey, targetPhoneNumber],
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
