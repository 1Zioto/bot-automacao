import { Router } from 'express';
import { z } from 'zod';
import { createContactSchema } from '@autoflow/contracts';
import { query, transaction } from '@autoflow/database';
import { createQueue, queueNames, type ContactImportJob } from '@autoflow/queue';
import { AppError, normalizePhoneNumber } from '@autoflow/shared';
import { recordAudit } from '../audit.js';
import { authenticate, requirePermission } from '../auth/middleware.js';
import type { AuthenticatedRequest } from '../types.js';

const router: Router = Router();
const contactImportQueue = createQueue<ContactImportJob>(queueNames.contactImports);
const importPhoneContactsSchema = z.object({ instanceId: z.uuid() });
router.use(authenticate);

router.get('/', requirePermission('contacts.read'), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const search = String(req.query.search ?? '').trim();
    const consentStatus = String(req.query.consentStatus ?? '').trim().toUpperCase();
    const validConsentStatuses = new Set(['UNKNOWN', 'GRANTED', 'REVOKED']);
    if (consentStatus && !validConsentStatuses.has(consentStatus)) {
      throw new AppError('INVALID_CONSENT_STATUS', 'Filtro de consentimento invalido.', 400);
    }
    const params = [auth.tenantId, search, consentStatus];
    const [rows, totals] = await Promise.all([
      query(
      `SELECT id, name, phone_number, email, consent_status, consent_source, consent_at,
              opted_out_at, blocked_at, notes, custom_fields, created_at, updated_at
       FROM contacts
       WHERE tenant_id = $1 AND deleted_at IS NULL
         AND ($2 = '' OR name ILIKE '%' || $2 || '%' OR phone_number LIKE '%' || $2 || '%' OR email ILIKE '%' || $2 || '%')
         AND ($3 = '' OR consent_status = $3)
       ORDER BY lower(name), id
       LIMIT $4 OFFSET $5`,
        [...params, limit, offset],
      ),
      query<{ total: number }>(
        `SELECT COUNT(*)::int AS total
         FROM contacts
         WHERE tenant_id = $1 AND deleted_at IS NULL
           AND ($2 = '' OR name ILIKE '%' || $2 || '%' OR phone_number LIKE '%' || $2 || '%' OR email ILIKE '%' || $2 || '%')
           AND ($3 = '' OR consent_status = $3)`,
        params,
      ),
    ]);
    res.json({ data: rows, limit, offset, total: totals[0]?.total ?? 0 });
  } catch (error) {
    next(error);
  }
});

router.post('/import-whatsapp', requirePermission('contacts.manage'), async (req, res, next) => {
  try {
    const input = importPhoneContactsSchema.parse(req.body);
    const auth = (req as AuthenticatedRequest).auth;
    const instances = await query<{ id: string }>(
      `SELECT id FROM whatsapp_instances
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         AND status = 'READY' AND connection_state = 'CONNECTED'`,
      [input.instanceId, auth.tenantId],
    );
    if (!instances[0]) throw new AppError('INSTANCE_NOT_READY', 'O WhatsApp selecionado nao esta conectado e pronto.', 409);

    const job = await contactImportQueue.add(
      'import-phone-contacts',
      { tenantId: auth.tenantId, instanceId: input.instanceId, requestedBy: auth.userId },
      { jobId: `contact-import-${auth.tenantId}-${input.instanceId}-${Date.now()}`, attempts: 5 },
    );
    await recordAudit(req, {
      action: 'contacts.phonebook_import_requested',
      entityType: 'WhatsAppInstance',
      entityId: input.instanceId,
      newValues: { jobId: job.id },
    });
    res.status(202).json({ jobId: job.id, status: 'QUEUED' });
  } catch (error) {
    next(error);
  }
});

router.get('/import-whatsapp/:jobId', requirePermission('contacts.read'), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const job = await contactImportQueue.getJob(req.params.jobId!);
    if (!job || job.data.tenantId !== auth.tenantId) {
      throw new AppError('CONTACT_IMPORT_NOT_FOUND', 'Importacao de contatos nao encontrada.', 404);
    }
    const state = await job.getState();
    res.json({
      jobId: job.id,
      state,
      progress: job.progress,
      result: job.returnvalue ?? null,
      error: state === 'failed' ? job.failedReason : null,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', requirePermission('contacts.manage'), async (req, res, next) => {
  try {
    const input = createContactSchema.parse(req.body);
    const auth = (req as AuthenticatedRequest).auth;
    const phoneNumber = normalizePhoneNumber(input.phoneNumber);
    if (input.consentStatus === 'GRANTED' && !input.consentAt) {
      throw new AppError('CONSENT_DATE_REQUIRED', 'Informe a data do consentimento.', 400);
    }
    const contact = await transaction(async (client) => {
      const inserted = await client.query<{ id: string; name: string; phone_number: string; consent_status: string }>(
        `INSERT INTO contacts
           (tenant_id, name, phone_number, email, consent_status, consent_source, consent_at, consent_evidence, notes, custom_fields)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         RETURNING id, name, phone_number, consent_status`,
        [
          auth.tenantId,
          input.name,
          phoneNumber,
          input.email ?? null,
          input.consentStatus,
          input.consentSource,
          input.consentAt ?? null,
          input.consentEvidence ?? null,
          input.notes ?? null,
          JSON.stringify(input.customFields),
        ],
      );
      const row = inserted.rows[0]!;
      await client.query(
        `INSERT INTO consent_events (tenant_id, contact_id, previous_status, new_status, source, evidence, user_id)
         VALUES ($1, $2, NULL, $3, $4, $5, $6)`,
        [auth.tenantId, row.id, input.consentStatus, input.consentSource, input.consentEvidence ?? null, auth.userId],
      );
      return row;
    });
    await recordAudit(req, { action: 'contact.created', entityType: 'Contact', entityId: contact.id, newValues: contact });
    res.status(201).json(contact);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/opt-out', requirePermission('contacts.manage'), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const rows = await query<{ id: string }>(
      `UPDATE contacts SET consent_status = 'REVOKED', opted_out_at = now(), updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING id`,
      [req.params.id, auth.tenantId],
    );
    if (!rows[0]) throw new AppError('CONTACT_NOT_FOUND', 'Contato nao encontrado.', 404);
    await query(
      `INSERT INTO consent_events (tenant_id, contact_id, previous_status, new_status, source, user_id)
       VALUES ($1, $2, NULL, 'REVOKED', 'MANUAL_OPT_OUT', $3)`,
      [auth.tenantId, rows[0].id, auth.userId],
    );
    await recordAudit(req, { action: 'contact.opted_out', entityType: 'Contact', entityId: rows[0].id });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export { router as contactsRouter };
