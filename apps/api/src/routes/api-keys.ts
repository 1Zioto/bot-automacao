import { Router } from 'express';
import { z } from 'zod';
import { query } from '@autoflow/database';
import { createApiKey } from '@autoflow/security';
import { AppError } from '@autoflow/shared';
import { recordAudit } from '../audit.js';
import { authenticate, requirePermission } from '../auth/middleware.js';
import type { AuthenticatedRequest } from '../types.js';

const router: Router = Router();
const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  scopes: z.array(z.enum(['messages:write', 'messages:read', 'contacts:read', 'contacts:write', 'instances:read', 'usage:read'])).min(1),
  expiresAt: z.iso.datetime().optional(),
});
router.use(authenticate, requirePermission('integrations.manage'));

router.get('/', async (req, res, next) => {
  try {
    const auth = (req as unknown as AuthenticatedRequest).auth;
    const rows = await query(
      `SELECT id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at
       FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
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
    const plan = await query<{ api_access_level: string }>(
      `SELECT p.api_access_level FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.tenant_id = $1 AND s.status IN ('TRIALING', 'ACTIVE', 'GRACE_PERIOD')`,
      [auth.tenantId],
    );
    if (!plan[0] || plan[0].api_access_level === 'NONE') throw new AppError('API_NOT_INCLUDED', 'API nao incluida no plano.', 403);
    if (plan[0].api_access_level === 'BASIC' && input.scopes.some((scope) => !['messages:write', 'messages:read', 'instances:read'].includes(scope))) {
      throw new AppError('SCOPE_NOT_INCLUDED', 'Escopo nao incluido no plano.', 403);
    }
    const key = createApiKey();
    const rows = await query<{ id: string; name: string; key_prefix: string; scopes: string[]; created_at: Date }>(
      `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7)
       RETURNING id, name, key_prefix, scopes, created_at`,
      [auth.tenantId, input.name, key.prefix, key.hash, input.scopes, input.expiresAt ?? null, auth.userId],
    );
    await recordAudit(req, { action: 'api_key.created', entityType: 'ApiKey', entityId: rows[0]!.id, newValues: { name: input.name, scopes: input.scopes } });
    res.status(201).json({ ...rows[0], key: key.plainText });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const auth = (req as unknown as AuthenticatedRequest).auth;
    const rows = await query<{ id: string }>(
      'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL RETURNING id',
      [req.params.id, auth.tenantId],
    );
    if (!rows[0]) throw new AppError('API_KEY_NOT_FOUND', 'Chave nao encontrada.', 404);
    await recordAudit(req, { action: 'api_key.revoked', entityType: 'ApiKey', entityId: rows[0].id });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export { router as apiKeysRouter };
