import { Router } from 'express';
import { createCampaignSchema, startCampaignSchema } from '@autoflow/contracts';
import { query, transaction } from '@autoflow/database';
import { createQueue, queueNames, type CampaignPreparationJob } from '@autoflow/queue';
import { AppError, renderTemplate } from '@autoflow/shared';
import { recordAudit } from '../audit.js';
import { emitEventSafely } from '../events.js';
import { authenticate, requirePermission } from '../auth/middleware.js';
import type { AuthenticatedRequest } from '../types.js';

const router: Router = Router();
const preparationQueue = createQueue<CampaignPreparationJob>(queueNames.campaignPreparation);
router.use(authenticate);

router.get('/', requirePermission('campaigns.read'), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const rows = await query(
      `SELECT c.id, c.name, c.status, c.scheduled_at, c.started_at, c.completed_at,
              c.total_recipients, c.queued_count, c.sent_count, c.delivered_count,
              c.read_count, c.failed_count, c.skipped_count, i.name AS instance_name
       FROM campaigns c
       JOIN whatsapp_instances i ON i.tenant_id = c.tenant_id AND i.id = c.instance_id
       WHERE c.tenant_id = $1
       ORDER BY c.created_at DESC`,
      [auth.tenantId],
    );
    res.json({ data: rows });
  } catch (error) {
    next(error);
  }
});

router.post('/', requirePermission('campaigns.manage'), async (req, res, next) => {
  try {
    const input = createCampaignSchema.parse(req.body);
    const auth = (req as AuthenticatedRequest).auth;
    const campaign = await transaction(async (client) => {
      const instance = await client.query(
        `SELECT id FROM whatsapp_instances
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND status != 'DESTROYED'`,
        [input.instanceId, auth.tenantId],
      );
      if (!instance.rows[0]) throw new AppError('INSTANCE_NOT_FOUND', 'Instancia nao encontrada.', 404);
      const lists = await client.query<{ id: string }>(
        `SELECT id FROM contact_lists
         WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND status = 'ACTIVE'`,
        [auth.tenantId, input.listIds],
      );
      if (lists.rows.length !== new Set(input.listIds).size) throw new AppError('INVALID_LIST_REFERENCE', 'Uma ou mais listas nao pertencem a empresa.', 400);
      const inserted = await client.query<{ id: string; name: string; status: string }>(
        `INSERT INTO campaigns
           (tenant_id, instance_id, name, message_template, media_id, status, scheduled_at, created_by)
         VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6, $7)
         RETURNING id, name, status`,
        [auth.tenantId, input.instanceId, input.name, input.messageTemplate, input.mediaId ?? null, input.scheduledAt ?? null, auth.userId],
      );
      await client.query(
        `INSERT INTO campaign_lists (tenant_id, campaign_id, list_id)
         SELECT $1, $2, unnest($3::uuid[])`,
        [auth.tenantId, inserted.rows[0]!.id, input.listIds],
      );
      return inserted.rows[0]!;
    });
    await recordAudit(req, { action: 'campaign.created', entityType: 'Campaign', entityId: campaign.id, newValues: campaign });
    await emitEventSafely(auth.tenantId, 'campaign.created', campaign);
    res.status(201).json(campaign);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/preview', requirePermission('campaigns.read'), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const rows = await query<{ message_template: string; name: string; phone_number: string; custom_fields: Record<string, unknown> }>(
      `SELECT c.message_template, ct.name, ct.phone_number, ct.custom_fields
       FROM campaigns c
       JOIN campaign_lists cl ON cl.tenant_id = c.tenant_id AND cl.campaign_id = c.id
       JOIN contact_list_members lm ON lm.tenant_id = cl.tenant_id AND lm.list_id = cl.list_id AND lm.removed_at IS NULL
       JOIN contacts ct ON ct.tenant_id = lm.tenant_id AND ct.id = lm.contact_id
       WHERE c.id = $1 AND c.tenant_id = $2 AND ct.deleted_at IS NULL
       ORDER BY ct.name LIMIT 1`,
      [req.params.id, auth.tenantId],
    );
    if (!rows[0]) throw new AppError('NO_PREVIEW_CONTACT', 'Campanha sem contato para pre-visualizacao.', 404);
    const sample = rows[0];
    res.json({ renderedMessage: renderTemplate(sample.message_template, { ...sample.custom_fields, nome: sample.name, numero: sample.phone_number }) });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/start', requirePermission('campaigns.send'), async (req, res, next) => {
  try {
    startCampaignSchema.parse(req.body);
    const auth = (req as AuthenticatedRequest).auth;
    const rows = await query<{ id: string; scheduled_at: Date | null }>(
      `UPDATE campaigns SET status = CASE WHEN scheduled_at > now() THEN 'SCHEDULED' ELSE 'PREPARING' END,
              consent_confirmed_at = now(), updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT'
       RETURNING id, scheduled_at`,
      [req.params.id, auth.tenantId],
    );
    if (!rows[0]) throw new AppError('INVALID_CAMPAIGN_STATE', 'Campanha inexistente ou ja iniciada.', 409);
    const delay = rows[0].scheduled_at ? Math.max(rows[0].scheduled_at.getTime() - Date.now(), 0) : 0;
    await preparationQueue.add(
      'prepare',
      { tenantId: auth.tenantId, campaignId: rows[0].id, requestedBy: auth.userId },
      { jobId: `prepare-${rows[0].id}`, delay },
    );
    await recordAudit(req, { action: 'campaign.started', entityType: 'Campaign', entityId: rows[0].id });
    await emitEventSafely(auth.tenantId, 'campaign.started', { id: rows[0].id, delay });
    res.status(202).json({ id: rows[0].id, queued: true, delay });
  } catch (error) {
    next(error);
  }
});

for (const action of ['pause', 'resume', 'cancel'] as const) {
  router.post(`/:id/${action}`, requirePermission('campaigns.manage'), async (req, res, next) => {
    try {
      const auth = (req as AuthenticatedRequest).auth;
      const target = action === 'pause' ? 'PAUSED' : action === 'resume' ? 'RUNNING' : 'CANCELED';
      const allowed = action === 'pause' ? ['PREPARING', 'RUNNING'] : action === 'resume' ? ['PAUSED'] : ['DRAFT', 'SCHEDULED', 'PREPARING', 'RUNNING', 'PAUSED'];
      const rows = await query<{ id: string; status: string }>(
        `UPDATE campaigns SET status = $3,
                paused_at = CASE WHEN $3 = 'PAUSED' THEN now() ELSE paused_at END,
                canceled_at = CASE WHEN $3 = 'CANCELED' THEN now() ELSE canceled_at END,
                updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND status = ANY($4::text[])
         RETURNING id, status`,
        [req.params.id, auth.tenantId, target, allowed],
      );
      if (!rows[0]) throw new AppError('INVALID_CAMPAIGN_STATE', 'Transicao de campanha invalida.', 409);
      if (target === 'CANCELED') {
        await query(
          `UPDATE campaign_recipients SET status = 'CANCELED', updated_at = now()
           WHERE tenant_id = $1 AND campaign_id = $2 AND status IN ('PENDING', 'QUEUED', 'DEFERRED')`,
          [auth.tenantId, rows[0].id],
        );
      }
      const eventAction = action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'canceled';
      await recordAudit(req, { action: `campaign.${eventAction}`, entityType: 'Campaign', entityId: rows[0].id });
      await emitEventSafely(auth.tenantId, `campaign.${eventAction}`, rows[0]);
      res.json(rows[0]);
    } catch (error) {
      next(error);
    }
  });
}

router.get('/:id/report', requirePermission('reports.read'), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const rows = await query(
      `SELECT c.id, c.name, c.status, c.total_recipients, c.queued_count, c.sent_count,
              c.delivered_count, c.read_count, c.failed_count, c.skipped_count,
              COUNT(r.id) FILTER (WHERE r.status = 'DEFERRED')::int AS deferred_count
       FROM campaigns c LEFT JOIN campaign_recipients r ON r.tenant_id = c.tenant_id AND r.campaign_id = c.id
       WHERE c.id = $1 AND c.tenant_id = $2
       GROUP BY c.id`,
      [req.params.id, auth.tenantId],
    );
    if (!rows[0]) throw new AppError('CAMPAIGN_NOT_FOUND', 'Campanha nao encontrada.', 404);
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

export { router as campaignsRouter };
