import { createHash } from 'node:crypto';
import type { Job } from 'bullmq';
import { getPool } from '@autoflow/database';
import {
  campaignPreparationJobSchema,
  createQueue,
  queueNames,
  type CampaignPreparationJob,
  type OutboundMessageJob,
} from '@autoflow/queue';
import { AppError, renderTemplate } from '@autoflow/shared';

interface CampaignRow {
  id: string;
  tenant_id: string;
  instance_id: string;
  message_template: string;
  status: string;
  tenant_name: string;
}

interface ContactRow {
  id: string;
  name: string;
  phone_number: string;
  custom_fields: Record<string, unknown>;
}

interface PreparedRecipient {
  id: string;
  tenantId: string;
  instanceId: string;
  idempotencyKey: string;
}

const outboundQueue = createQueue<OutboundMessageJob>(queueNames.outboundMessages);

export async function processCampaignPreparation(job: Job<CampaignPreparationJob>): Promise<{ prepared: number }> {
  const input = campaignPreparationJobSchema.parse(job.data);
  const client = await getPool().connect();
  let prepared: PreparedRecipient[] = [];
  try {
    await client.query('BEGIN');
    const campaignResult = await client.query<CampaignRow>(
      `SELECT c.id, c.tenant_id, c.instance_id, c.message_template, c.status, t.name AS tenant_name
       FROM campaigns c JOIN tenants t ON t.id = c.tenant_id
       WHERE c.id = $1 AND c.tenant_id = $2
       FOR UPDATE`,
      [input.campaignId, input.tenantId],
    );
    const campaign = campaignResult.rows[0];
    if (!campaign) throw new AppError('CAMPAIGN_NOT_FOUND', 'Campanha nao encontrada.', 404);
    if (campaign.status === 'CANCELED' || campaign.status === 'COMPLETED') {
      await client.query('COMMIT');
      return { prepared: 0 };
    }
    if (!['PREPARING', 'SCHEDULED'].includes(campaign.status)) {
      throw new AppError('INVALID_CAMPAIGN_STATE', `Campanha em estado ${campaign.status}.`, 409);
    }
    await client.query("UPDATE campaigns SET status = 'PREPARING', updated_at = now() WHERE id = $1", [campaign.id]);

    const contacts = await client.query<ContactRow>(
      `SELECT DISTINCT ct.id, ct.name, ct.phone_number, ct.custom_fields
       FROM campaign_lists cl
       JOIN contact_list_members lm
         ON lm.tenant_id = cl.tenant_id AND lm.list_id = cl.list_id AND lm.removed_at IS NULL
       JOIN contacts ct
         ON ct.tenant_id = lm.tenant_id AND ct.id = lm.contact_id
       WHERE cl.tenant_id = $1 AND cl.campaign_id = $2
         AND ct.deleted_at IS NULL
         AND ct.consent_status = 'GRANTED'
         AND ct.opted_out_at IS NULL
         AND ct.blocked_at IS NULL
       ORDER BY ct.id`,
      [input.tenantId, input.campaignId],
    );

    for (const contact of contacts.rows) {
      const idempotencyKey = createHash('sha256').update(`${campaign.id}:${contact.id}`).digest('hex');
      const rendered = renderTemplate(campaign.message_template, {
        ...contact.custom_fields,
        nome: contact.name,
        empresa: campaign.tenant_name,
        numero: contact.phone_number,
      });
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO campaign_recipients
           (tenant_id, campaign_id, contact_id, phone_number_snapshot, rendered_message, status, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, 'QUEUED', $6)
         ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [input.tenantId, campaign.id, contact.id, contact.phone_number, rendered, idempotencyKey],
      );
      prepared.push({
        id: inserted.rows[0]!.id,
        tenantId: input.tenantId,
        instanceId: campaign.instance_id,
        idempotencyKey,
      });
    }

    const nextStatus = prepared.length === 0 ? 'COMPLETED' : 'RUNNING';
    await client.query(
      `UPDATE campaigns
       SET status = $2, started_at = COALESCE(started_at, now()),
           completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() ELSE completed_at END,
           total_recipients = $3, queued_count = $3, updated_at = now()
       WHERE id = $1`,
      [campaign.id, nextStatus, prepared.length],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  if (prepared.length > 0) {
    await outboundQueue.addBulk(
      prepared.map((recipient) => ({
        name: 'send',
        data: {
          tenantId: recipient.tenantId,
          instanceId: recipient.instanceId,
          recipientId: recipient.id,
          idempotencyKey: recipient.idempotencyKey,
        },
        opts: { jobId: `outbound-${recipient.idempotencyKey}` },
      })),
    );
  }
  return { prepared: prepared.length };
}
