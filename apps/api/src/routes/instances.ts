import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { createInstanceSchema } from '@autoflow/contracts';
import { query } from '@autoflow/database';
import { getRedis } from '@autoflow/queue';
import { AppError } from '@autoflow/shared';
import { recordAudit } from '../audit.js';
import { emitEventSafely } from '../events.js';
import { authenticate, requirePermission } from '../auth/middleware.js';
import type { AuthenticatedRequest } from '../types.js';

const router: Router = Router();
router.use(authenticate);

interface PlanLimitRow {
  max_instances: number;
  custom_limits: Record<string, unknown>;
  additional_instances: number;
}

router.get('/', requirePermission('instances.read'), async (req, res, next) => {
  try {
    const { tenantId } = (req as AuthenticatedRequest).auth;
    const rows = await query(
      `SELECT id, name, phone_number, status, connection_state, last_heartbeat_at,
              connected_at, disconnected_at, last_error_code, last_error_message,
              daily_limit_override, sending_enabled, created_at, updated_at
       FROM whatsapp_instances
       WHERE tenant_id = $1 AND deleted_at IS NULL
       ORDER BY created_at`,
      [tenantId],
    );
    res.json({ data: rows });
  } catch (error) {
    next(error);
  }
});

router.post('/', requirePermission('instances.manage'), async (req, res, next) => {
  try {
    const input = createInstanceSchema.parse(req.body);
    const auth = (req as AuthenticatedRequest).auth;
    const limitRows = await query<PlanLimitRow>(
      `SELECT p.max_instances, s.custom_limits,
              COALESCE((SELECT SUM(quantity) FROM subscription_addons a WHERE a.tenant_id = s.tenant_id AND a.status = 'ACTIVE' AND a.code = 'ADDITIONAL_INSTANCE'), 0)::int AS additional_instances
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.tenant_id = $1 AND s.status IN ('TRIALING', 'ACTIVE', 'GRACE_PERIOD')`,
      [auth.tenantId],
    );
    const plan = limitRows[0];
    if (!plan) throw new AppError('SUBSCRIPTION_REQUIRED', 'Assinatura ativa obrigatoria.', 402);
    const customMax = Number(plan.custom_limits.maxInstances);
    const allowed = Number.isFinite(customMax) && customMax > 0 ? customMax : plan.max_instances + plan.additional_instances;
    const countRows = await query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM whatsapp_instances WHERE tenant_id = $1 AND deleted_at IS NULL AND status != $2',
      [auth.tenantId, 'DESTROYED'],
    );
    if ((countRows[0]?.count ?? 0) >= allowed) throw new AppError('INSTANCE_LIMIT_REACHED', 'Limite de instancias do plano atingido.', 409);

    const rows = await query<{ id: string; name: string; status: string }>(
      `INSERT INTO whatsapp_instances (tenant_id, name, client_id, status, created_by)
       VALUES ($1, $2, $3, 'CREATED', $4)
       RETURNING id, name, status`,
      [auth.tenantId, input.name, `wa-${auth.tenantId.slice(0, 8)}-${randomUUID()}`, auth.userId],
    );
    const instance = rows[0]!;
    await query(
      `INSERT INTO sending_windows (tenant_id, instance_id, day_of_week, start_time, end_time, enabled)
       VALUES
         ($1, $2, 0, NULL, NULL, false),
         ($1, $2, 1, '08:00', '18:00', true),
         ($1, $2, 2, '08:00', '18:00', true),
         ($1, $2, 3, '08:00', '18:00', true),
         ($1, $2, 4, '08:00', '18:00', true),
         ($1, $2, 5, '08:00', '18:00', true),
         ($1, $2, 6, '09:00', '13:00', true)
       ON CONFLICT (instance_id, day_of_week) DO NOTHING`,
      [auth.tenantId, instance.id],
    );
    await recordAudit(req, { action: 'instance.created', entityType: 'WhatsAppInstance', entityId: instance.id, newValues: instance });
    await emitEventSafely(auth.tenantId, 'instance.created', instance);
    res.status(201).json(instance);
  } catch (error) {
    next(error);
  }
});

router.get('/:id/status', requirePermission('instances.read'), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const rows = await query(
      `SELECT id, name, phone_number, status, connection_state, last_heartbeat_at,
              connected_at, disconnected_at, last_error_code, last_error_message, sending_enabled
       FROM whatsapp_instances WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [req.params.id, auth.tenantId],
    );
    if (!rows[0]) throw new AppError('INSTANCE_NOT_FOUND', 'Instancia nao encontrada.', 404);
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

router.get('/:id/qr', requirePermission('instances.read'), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const rows = await query<{ id: string; status: string; qr_code?: string | null; last_error_message?: string | null }>(
      'SELECT id, status, qr_code, last_error_message FROM whatsapp_instances WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
      [req.params.id, auth.tenantId],
    );
    if (!rows[0]) throw new AppError('INSTANCE_NOT_FOUND', 'Instancia nao encontrada.', 404);
    let qr: string | null = null;
    try {
      qr = await getRedis().get(`wa:instance:${req.params.id}:qr`);
    } catch {
      // Redis opcional / fallback
    }
    if (!qr && rows[0].qr_code) {
      qr = rows[0].qr_code;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: rows[0].status, qr, error: rows[0].last_error_message ?? null });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/initialize', requirePermission('instances.manage'), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const rows = await query<{ id: string; status: string }>(
       `UPDATE whatsapp_instances
       SET status = 'INITIALIZING', qr_code = NULL, connection_state = 'UNPAIRED',
           worker_id = NULL, last_heartbeat_at = NULL,
           last_error_code = NULL, last_error_message = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       RETURNING id, status`,
      [req.params.id, auth.tenantId],
    );
    if (!rows[0]) throw new AppError('INSTANCE_NOT_FOUND', 'Instancia nao encontrada.', 404);
    await recordAudit(req, { action: 'instance.initialize_requested', entityType: 'WhatsAppInstance', entityId: rows[0].id });
    res.status(202).json(rows[0]);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/pause', requirePermission('instances.manage'), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const rows = await query<{ id: string; status: string }>(
      `UPDATE whatsapp_instances
       SET status = 'PAUSED', connection_state = 'DISCONNECTED', qr_code = NULL,
           worker_id = NULL, last_error_message = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       RETURNING id, status`,
      [req.params.id, auth.tenantId],
    );
    if (!rows[0]) throw new AppError('INSTANCE_NOT_FOUND', 'Instancia nao encontrada.', 404);
    try {
      await getRedis().del(`wa:instance:${req.params.id}:qr`);
    } catch {}
    await recordAudit(req, { action: 'instance.paused', entityType: 'WhatsAppInstance', entityId: rows[0].id });
    await emitEventSafely(auth.tenantId, 'instance.disconnected', { instanceId: rows[0].id, reason: 'PAUSED' });
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', requirePermission('instances.manage'), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const rows = await query<{ id: string; status: string }>(
      `UPDATE whatsapp_instances
       SET status = 'DESTROYED', connection_state = 'DISCONNECTED', qr_code = NULL,
           worker_id = NULL,
           name = name || ' (excluida ' || to_char(now(), 'YYYY-MM-DD HH24:MI:SS') || ')',
           deleted_at = now(), updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       RETURNING id, status`,
      [req.params.id, auth.tenantId],
    );
    if (!rows[0]) throw new AppError('INSTANCE_NOT_FOUND', 'Instancia nao encontrada.', 404);
    try {
      await getRedis().del(`wa:instance:${req.params.id}:qr`);
    } catch {}
    await recordAudit(req, { action: 'instance.deleted', entityType: 'WhatsAppInstance', entityId: rows[0].id });
    await emitEventSafely(auth.tenantId, 'instance.disconnected', { instanceId: rows[0].id, reason: 'DELETED' });
    res.json({ success: true, id: rows[0].id });
  } catch (error) {
    next(error);
  }
});

export { router as instancesRouter };

