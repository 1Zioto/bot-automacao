import { Router } from 'express';
import { z } from 'zod';
import { query, transaction } from '@autoflow/database';
import { AppError } from '@autoflow/shared';
import { authenticate } from '../auth/middleware.js';
import { requirePlatformAdmin } from '../auth/platform-admin.js';
import type { AuthenticatedRequest } from '../types.js';

const tenantStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) });
const applyChangeSchema = z.object({ providerReference: z.string().trim().min(4).max(200) });
const router: Router = Router();
router.use(authenticate, requirePlatformAdmin);

router.get('/dashboard', async (_req, res, next) => {
  try {
    const rows = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM tenants WHERE status IN ('TRIAL', 'ACTIVE')) AS active_tenants,
         (SELECT COUNT(*)::int FROM users WHERE status = 'ACTIVE') AS active_users,
         (SELECT COUNT(*)::int FROM whatsapp_instances WHERE status = 'READY' AND deleted_at IS NULL) AS ready_instances,
         (SELECT COUNT(*)::int FROM campaigns WHERE status = 'RUNNING') AS running_campaigns,
         (SELECT COALESCE(SUM(sent), 0)::int FROM daily_usage WHERE date = CURRENT_DATE) AS messages_today,
         (SELECT COUNT(*)::int FROM subscription_change_requests WHERE status = 'PENDING') AS pending_plan_changes,
         (SELECT COUNT(*)::int FROM webhook_deliveries WHERE status = 'FAILED' AND created_at > now() - interval '24 hours') AS webhook_failures_24h`,
    );
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

router.get('/tenants', async (req, res, next) => {
  try {
    const search = String(req.query.search ?? '').trim();
    const rows = await query(
      `SELECT t.id, t.name, t.slug, t.document, t.timezone, t.status, t.created_at,
              p.code AS plan_code, p.name AS plan_name, s.status AS subscription_status,
              COUNT(DISTINCT m.id) FILTER (WHERE m.status != 'REMOVED')::int AS users,
              COUNT(DISTINCT i.id) FILTER (WHERE i.deleted_at IS NULL)::int AS instances
       FROM tenants t
       LEFT JOIN subscriptions s ON s.tenant_id = t.id
       LEFT JOIN plans p ON p.id = s.plan_id
       LEFT JOIN memberships m ON m.tenant_id = t.id
       LEFT JOIN whatsapp_instances i ON i.tenant_id = t.id
       WHERE t.status != 'DELETED' AND ($1 = '' OR t.name ILIKE '%' || $1 || '%' OR t.slug ILIKE '%' || $1 || '%')
       GROUP BY t.id, p.code, p.name, s.status
       ORDER BY t.created_at DESC LIMIT 200`,
      [search],
    );
    res.json({ data: rows });
  } catch (error) {
    next(error);
  }
});

router.patch('/tenants/:id/status', async (req, res, next) => {
  try {
    const input = tenantStatusSchema.parse(req.body);
    const auth = (req as unknown as AuthenticatedRequest).auth;
    const tenant = await transaction(async (client) => {
      const changed = await client.query<{ id: string; name: string; status: string }>(
        `UPDATE tenants SET status = $2, updated_at = now()
         WHERE id = $1 AND status != 'DELETED' RETURNING id, name, status`,
        [req.params.id, input.status],
      );
      if (!changed.rows[0]) throw new AppError('TENANT_NOT_FOUND', 'Empresa nao encontrada.', 404);
      if (input.status === 'SUSPENDED') {
        await client.query("UPDATE whatsapp_instances SET sending_enabled = false, status = CASE WHEN status = 'READY' THEN 'PAUSED' ELSE status END, updated_at = now() WHERE tenant_id = $1", [req.params.id]);
        await client.query('UPDATE auth_sessions SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL', [req.params.id]);
      }
      await client.query(
        `INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, new_values, ip_address, user_agent)
         VALUES ($1, $2, 'platform.tenant_status_changed', 'Tenant', $1, $3::jsonb, $4, $5)`,
        [req.params.id, auth.userId, JSON.stringify(input), req.ip, req.headers['user-agent'] ?? null],
      );
      return changed.rows[0];
    });
    res.json(tenant);
  } catch (error) {
    next(error);
  }
});

router.get('/subscription-changes', async (_req, res, next) => {
  try {
    const rows = await query(
      `SELECT r.id, r.tenant_id, t.name AS tenant_name, current.code AS current_plan,
              requested.code AS requested_plan, r.status, r.provider_reference, r.created_at
       FROM subscription_change_requests r
       JOIN tenants t ON t.id = r.tenant_id
       JOIN subscriptions s ON s.id = r.subscription_id AND s.tenant_id = r.tenant_id
       JOIN plans current ON current.id = s.plan_id
       JOIN plans requested ON requested.id = r.requested_plan_id
       ORDER BY r.created_at DESC LIMIT 200`,
    );
    res.json({ data: rows });
  } catch (error) {
    next(error);
  }
});

router.post('/subscription-changes/:id/apply', async (req, res, next) => {
  try {
    const input = applyChangeSchema.parse(req.body);
    const auth = (req as unknown as AuthenticatedRequest).auth;
    const applied = await transaction(async (client) => {
      const request = await client.query<{ id: string; tenant_id: string; subscription_id: string; requested_plan_id: string }>(
        `SELECT id, tenant_id, subscription_id, requested_plan_id
         FROM subscription_change_requests WHERE id = $1 AND status = 'PENDING' FOR UPDATE`,
        [req.params.id],
      );
      const change = request.rows[0];
      if (!change) throw new AppError('PLAN_CHANGE_NOT_FOUND', 'Solicitacao pendente nao encontrada.', 404);
      await client.query(
        `UPDATE subscriptions SET plan_id = $2, status = 'ACTIVE', updated_at = now()
         WHERE id = $1 AND tenant_id = $3`,
        [change.subscription_id, change.requested_plan_id, change.tenant_id],
      );
      await client.query(
        `UPDATE subscription_change_requests SET status = 'APPLIED', provider_reference = $2,
                effective_at = now(), resolved_at = now() WHERE id = $1`,
        [change.id, input.providerReference],
      );
      await client.query(
        `INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, new_values, ip_address, user_agent)
         VALUES ($1, $2, 'platform.plan_change_applied', 'SubscriptionChangeRequest', $3, $4::jsonb, $5, $6)`,
        [change.tenant_id, auth.userId, change.id, JSON.stringify(input), req.ip, req.headers['user-agent'] ?? null],
      );
      return { id: change.id, tenantId: change.tenant_id, status: 'APPLIED' };
    });
    res.json(applied);
  } catch (error) {
    next(error);
  }
});

export { router as adminRouter };
