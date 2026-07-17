import { Router } from 'express';
import { z } from 'zod';
import { query } from '@autoflow/database';
import { AppError } from '@autoflow/shared';
import { recordAudit } from '../audit.js';
import { authenticate, requirePermission } from '../auth/middleware.js';
import type { AuthenticatedRequest } from '../types.js';

const changePlanSchema = z.object({ planCode: z.string().trim().min(2).max(40) });
const catalogRouter: Router = Router();
const billingRouter: Router = Router();

catalogRouter.get('/', async (_req, res, next) => {
  try {
    const plans = await query(
      `SELECT code, name, description, monthly_price, max_instances, max_users,
              daily_messages_per_instance, max_active_lists, api_access_level,
              webhooks_enabled, advanced_reports_enabled, audit_enabled,
              support_level, metadata
       FROM plans WHERE is_active = true ORDER BY monthly_price`,
    );
    res.json({ data: plans });
  } catch (error) {
    next(error);
  }
});

billingRouter.use(authenticate, requirePermission('billing.manage'));

billingRouter.get('/subscription', async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const subscriptions = await query(
      `SELECT s.id, s.status, s.billing_cycle, s.current_period_start, s.current_period_end,
              s.trial_ends_at, s.provider, s.custom_limits,
              p.code AS plan_code, p.name AS plan_name, p.monthly_price,
              p.max_instances, p.max_users, p.daily_messages_per_instance,
              p.max_active_lists, p.api_access_level, p.webhooks_enabled,
              p.advanced_reports_enabled, p.audit_enabled, p.support_level
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.tenant_id = $1`,
      [auth.tenantId],
    );
    if (!subscriptions[0]) throw new AppError('SUBSCRIPTION_NOT_FOUND', 'Assinatura nao encontrada.', 404);
    const addons = await query(
      `SELECT id, code, quantity, unit_price, limits, status, created_at
       FROM subscription_addons WHERE tenant_id = $1 AND status != 'CANCELED'`,
      [auth.tenantId],
    );
    const pendingChanges = await query(
      `SELECT r.id, p.code AS requested_plan_code, p.name AS requested_plan_name,
              r.status, r.effective_at, r.created_at
       FROM subscription_change_requests r JOIN plans p ON p.id = r.requested_plan_id
       WHERE r.tenant_id = $1 AND r.status = 'PENDING'`,
      [auth.tenantId],
    );
    res.json({ subscription: subscriptions[0], addons, pendingChange: pendingChanges[0] ?? null });
  } catch (error) {
    next(error);
  }
});

billingRouter.post('/change-plan', async (req, res, next) => {
  try {
    const input = changePlanSchema.parse(req.body);
    const auth = (req as AuthenticatedRequest).auth;
    const rows = await query<{ id: string; requested_plan_code: string; status: string }>(
      `INSERT INTO subscription_change_requests
         (tenant_id, subscription_id, requested_plan_id, requested_by)
       SELECT s.tenant_id, s.id, requested.id, $3
       FROM subscriptions s
       JOIN plans current_plan ON current_plan.id = s.plan_id
       JOIN plans requested ON requested.code = $2 AND requested.is_active = true
       WHERE s.tenant_id = $1 AND s.status IN ('TRIALING', 'ACTIVE', 'GRACE_PERIOD')
         AND requested.id != current_plan.id
       RETURNING id, $2::text AS requested_plan_code, status`,
      [auth.tenantId, input.planCode.toUpperCase(), auth.userId],
    );
    if (!rows[0]) throw new AppError('INVALID_PLAN_CHANGE', 'Plano invalido ou ja contratado.', 409);
    await recordAudit(req, { action: 'subscription.change_requested', entityType: 'SubscriptionChangeRequest', entityId: rows[0].id, newValues: input });
    res.status(202).json({ ...rows[0], message: 'Alteracao aguardando confirmacao do provedor de cobranca.' });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === '23505') {
      next(new AppError('PLAN_CHANGE_PENDING', 'Ja existe uma alteracao de plano pendente.', 409));
      return;
    }
    next(error);
  }
});

billingRouter.delete('/change-plan/:id', async (req, res, next) => {
  try {
    const auth = (req as unknown as AuthenticatedRequest).auth;
    const rows = await query<{ id: string }>(
      `UPDATE subscription_change_requests SET status = 'CANCELED', resolved_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING' RETURNING id`,
      [req.params.id, auth.tenantId],
    );
    if (!rows[0]) throw new AppError('PLAN_CHANGE_NOT_FOUND', 'Solicitacao pendente nao encontrada.', 404);
    await recordAudit(req, { action: 'subscription.change_canceled', entityType: 'SubscriptionChangeRequest', entityId: rows[0].id });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export { billingRouter, catalogRouter };
