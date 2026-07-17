import { Router } from 'express';
import { createListSchema } from '@autoflow/contracts';
import { query, transaction } from '@autoflow/database';
import { AppError } from '@autoflow/shared';
import { recordAudit } from '../audit.js';
import { authenticate, requirePermission } from '../auth/middleware.js';
import type { AuthenticatedRequest } from '../types.js';

const router: Router = Router();
router.use(authenticate);

router.get('/', requirePermission('contacts.read'), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const rows = await query(
      `SELECT l.id, l.name, l.description, l.status, l.created_at, l.updated_at,
              COUNT(m.id) FILTER (WHERE m.removed_at IS NULL)::int AS contact_count
       FROM contact_lists l
       LEFT JOIN contact_list_members m ON m.tenant_id = l.tenant_id AND m.list_id = l.id
       WHERE l.tenant_id = $1
       GROUP BY l.id
       ORDER BY l.name`,
      [auth.tenantId],
    );
    res.json({ data: rows });
  } catch (error) {
    next(error);
  }
});

router.post('/', requirePermission('contacts.manage'), async (req, res, next) => {
  try {
    const input = createListSchema.parse(req.body);
    const auth = (req as AuthenticatedRequest).auth;
    const list = await transaction(async (client) => {
      const subscription = await client.query<{ max_active_lists: number | null }>(
        `SELECT p.max_active_lists FROM subscriptions s JOIN plans p ON p.id = s.plan_id
         WHERE s.tenant_id = $1 AND s.status IN ('TRIALING', 'ACTIVE', 'GRACE_PERIOD')`,
        [auth.tenantId],
      );
      if (!subscription.rows[0]) throw new AppError('SUBSCRIPTION_REQUIRED', 'Assinatura ativa obrigatoria.', 402);
      if (subscription.rows[0].max_active_lists) {
        const count = await client.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM contact_lists WHERE tenant_id = $1 AND status = 'ACTIVE'",
          [auth.tenantId],
        );
        if ((count.rows[0]?.count ?? 0) >= subscription.rows[0].max_active_lists) {
          throw new AppError('LIST_LIMIT_REACHED', 'Limite de listas ativas atingido.', 409);
        }
      }
      const inserted = await client.query<{ id: string; name: string; description: string | null }>(
        `INSERT INTO contact_lists (tenant_id, name, description, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id, name, description`,
        [auth.tenantId, input.name, input.description ?? null, auth.userId],
      );
      const row = inserted.rows[0]!;
      if (input.contactIds.length > 0) {
        const contacts = await client.query<{ id: string }>(
          'SELECT id FROM contacts WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL',
          [auth.tenantId, input.contactIds],
        );
        if (contacts.rows.length !== new Set(input.contactIds).size) {
          throw new AppError('INVALID_CONTACT_REFERENCE', 'Um ou mais contatos nao pertencem a empresa.', 400);
        }
        await client.query(
          `INSERT INTO contact_list_members (tenant_id, list_id, contact_id)
           SELECT $1, $2, unnest($3::uuid[])`,
          [auth.tenantId, row.id, input.contactIds],
        );
      }
      return row;
    });
    await recordAudit(req, { action: 'list.created', entityType: 'ContactList', entityId: list.id, newValues: list });
    res.status(201).json(list);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/contacts', requirePermission('contacts.manage'), async (req, res, next) => {
  try {
    const contactId = String(req.body.contactId ?? '');
    const auth = (req as AuthenticatedRequest).auth;
    const rows = await query(
      `INSERT INTO contact_list_members (tenant_id, list_id, contact_id)
       SELECT $1, l.id, c.id
       FROM contact_lists l JOIN contacts c ON c.tenant_id = l.tenant_id
       WHERE l.id = $2 AND c.id = $3 AND l.tenant_id = $1 AND c.deleted_at IS NULL
       ON CONFLICT (list_id, contact_id) DO UPDATE SET removed_at = NULL, added_at = now()
       RETURNING id`,
      [auth.tenantId, req.params.id, contactId],
    );
    if (!rows[0]) throw new AppError('INVALID_REFERENCE', 'Lista ou contato invalido.', 400);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.delete('/:id/contacts/:contactId', requirePermission('contacts.manage'), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    await query(
      `UPDATE contact_list_members SET removed_at = now()
       WHERE tenant_id = $1 AND list_id = $2 AND contact_id = $3 AND removed_at IS NULL`,
      [auth.tenantId, req.params.id, req.params.contactId],
    );
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export { router as listsRouter };
