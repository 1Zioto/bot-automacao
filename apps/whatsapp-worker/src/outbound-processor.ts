import { DelayedError, type Job } from 'bullmq';
import { connect, query } from '@autoflow/database';
import { emitWebhookEvent } from '@autoflow/events';
import {
  DistributedLock,
  getRedis,
  outboundMessageJobSchema,
  releaseDailyUsage,
  reserveDailyUsage,
  type OutboundMessageJob,
} from '@autoflow/queue';
import { encryptText } from '@autoflow/security';
import { AppError, localDateKey } from '@autoflow/shared';
import type { InstanceManager } from './instance-manager.js';
import { isInsideWindow, localClock } from './sending-window.js';

interface RecipientRow {
  id: string;
  tenant_id: string;
  campaign_id: string;
  instance_id: string;
  contact_id: string;
  phone_number_snapshot: string;
  rendered_message: string;
  status: string;
  campaign_status: string;
  consent_status: string;
  opted_out_at: Date | null;
  blocked_at: Date | null;
  timezone: string;
  daily_limit: number;
}

export function createOutboundProcessor(manager: InstanceManager) {
  return async (job: Job<OutboundMessageJob>, token?: string): Promise<{ externalMessageId?: string; skipped?: string }> => {
    const input = outboundMessageJobSchema.parse(job.data);
    const lock = new DistributedLock(`wa:instance:${input.instanceId}:send`, 120_000);
    if (!(await lock.acquire())) throw new AppError('INSTANCE_BUSY', 'Instancia processando outro envio.', 503);
    let usageDate: string | undefined;
    let usageReserved = false;
    try {
      const client = await connect();
      let recipient: RecipientRow | undefined;
      try {
        await client.query('BEGIN');
        const result = await client.query<RecipientRow>(
          `SELECT r.id, r.tenant_id, r.campaign_id, c.instance_id, r.contact_id,
                  r.phone_number_snapshot, r.rendered_message, r.status,
                  c.status AS campaign_status, ct.consent_status, ct.opted_out_at, ct.blocked_at,
                  t.timezone,
                  COALESCE(i.daily_limit_override, p.daily_messages_per_instance) AS daily_limit
           FROM campaign_recipients r
           JOIN campaigns c ON c.tenant_id = r.tenant_id AND c.id = r.campaign_id
           JOIN contacts ct ON ct.tenant_id = r.tenant_id AND ct.id = r.contact_id
           JOIN whatsapp_instances i ON i.tenant_id = c.tenant_id AND i.id = c.instance_id
           JOIN tenants t ON t.id = r.tenant_id
           JOIN subscriptions s ON s.tenant_id = r.tenant_id AND s.status IN ('TRIALING', 'ACTIVE', 'GRACE_PERIOD')
           JOIN plans p ON p.id = s.plan_id
           WHERE r.id = $1 AND r.tenant_id = $2 AND c.instance_id = $3
           FOR UPDATE OF r`,
          [input.recipientId, input.tenantId, input.instanceId],
        );
        recipient = result.rows[0];
        if (!recipient) throw new AppError('RECIPIENT_NOT_FOUND', 'Destinatario nao encontrado.', 404);
        if (['SENT', 'DELIVERED', 'READ'].includes(recipient.status)) {
          await client.query('COMMIT');
          return { skipped: 'ALREADY_SENT' };
        }
        if (recipient.campaign_status === 'CANCELED') {
          await client.query("UPDATE campaign_recipients SET status = 'CANCELED', updated_at = now() WHERE id = $1", [recipient.id]);
          await client.query('COMMIT');
          return { skipped: 'CAMPAIGN_CANCELED' };
        }
        if (recipient.campaign_status === 'PAUSED') {
          await client.query("UPDATE campaign_recipients SET status = 'DEFERRED', updated_at = now() WHERE id = $1", [recipient.id]);
          await client.query('COMMIT');
          if (!token) throw new AppError('MISSING_JOB_TOKEN', 'Token do job ausente.', 500);
          await job.moveToDelayed(Date.now() + 60_000, token);
          throw new DelayedError();
        }
        if (recipient.campaign_status !== 'RUNNING') throw new AppError('CAMPAIGN_NOT_RUNNING', 'Campanha nao esta em execucao.', 409);
        if (recipient.consent_status !== 'GRANTED' || recipient.opted_out_at || recipient.blocked_at) {
          await client.query(
            `UPDATE campaign_recipients SET status = 'SKIPPED', failure_code = 'NO_CONSENT', updated_at = now() WHERE id = $1`,
            [recipient.id],
          );
          await client.query("UPDATE campaigns SET skipped_count = skipped_count + 1, updated_at = now() WHERE id = $1", [recipient.campaign_id]);
          await client.query('COMMIT');
          return { skipped: 'NO_CONSENT' };
        }
        await client.query("UPDATE campaign_recipients SET status = 'SENDING', attempt_count = attempt_count + 1, updated_at = now() WHERE id = $1", [recipient.id]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      const acceptedCacheKey = `wa:outbound:accepted:${input.idempotencyKey}`;
      const acceptedCache = await getRedis().get(acceptedCacheKey);
      if (acceptedCache) {
        const accepted = JSON.parse(acceptedCache) as { externalMessageId: string; usageDate: string };
        await persistAcceptedMessage(recipient, accepted.externalMessageId, accepted.usageDate);
        await getRedis().del(acceptedCacheKey);
        await emitWebhookEvent(recipient.tenant_id, 'message.sent', { recipientId: recipient.id, campaignId: recipient.campaign_id, externalMessageId: accepted.externalMessageId }).catch(() => undefined);
        await completeCampaignIfFinished(recipient.campaign_id, recipient.tenant_id);
        return { externalMessageId: accepted.externalMessageId };
      }

      const windows = await query<{ day_of_week: number; start_time: string | null; end_time: string | null; enabled: boolean }>(
        `SELECT day_of_week, start_time::text, end_time::text, enabled
         FROM sending_windows WHERE tenant_id = $1 AND instance_id = $2`,
        [recipient.tenant_id, recipient.instance_id],
      );
      if (windows.length > 0 && !windows.some((window) => isInsideWindow(localClock(new Date(), recipient.timezone), window))) {
        await query("UPDATE campaign_recipients SET status = 'DEFERRED', updated_at = now() WHERE id = $1", [recipient.id]);
        if (!token) throw new AppError('MISSING_JOB_TOKEN', 'Token do job ausente.', 500);
        await job.moveToDelayed(Date.now() + 5 * 60_000, token);
        throw new DelayedError();
      }
      if (!manager.hasReadyClient(recipient.instance_id)) {
        await query("UPDATE campaign_recipients SET status = 'DEFERRED', updated_at = now() WHERE id = $1", [recipient.id]);
        if (!token) throw new AppError('MISSING_JOB_TOKEN', 'Token do job ausente.', 500);
        await job.moveToDelayed(Date.now() + 15_000, token);
        throw new DelayedError();
      }

      usageDate = localDateKey(new Date(), recipient.timezone);
      const usage = await reserveDailyUsage(recipient.instance_id, usageDate, recipient.daily_limit);
      if (!usage.allowed) {
        await query("UPDATE campaign_recipients SET status = 'DEFERRED', failure_code = 'DAILY_LIMIT', updated_at = now() WHERE id = $1", [recipient.id]);
        const firstNotice = await getRedis().set(`usage:limit-event:${recipient.instance_id}:${usageDate}`, '1', 'PX', 172_800_000, 'NX');
        if (firstNotice) await emitWebhookEvent(recipient.tenant_id, 'usage.daily_limit_reached', { instanceId: recipient.instance_id, date: usageDate, limit: recipient.daily_limit }).catch(() => undefined);
        if (!token) throw new AppError('MISSING_JOB_TOKEN', 'Token do job ausente.', 500);
        await job.moveToDelayed(Date.now() + 15 * 60_000, token);
        throw new DelayedError();
      }
      usageReserved = true;

      const externalMessageId = await manager.sendText(
        recipient.instance_id,
        recipient.phone_number_snapshot,
        recipient.rendered_message,
        input.idempotencyKey,
      );
      await getRedis().set(
        acceptedCacheKey,
        JSON.stringify({ externalMessageId, usageDate }),
        'EX',
        7 * 24 * 60 * 60,
      );
      usageReserved = false;
      await persistAcceptedMessage(recipient, externalMessageId, usageDate);
      await getRedis().del(acceptedCacheKey);
      await emitWebhookEvent(recipient.tenant_id, 'message.sent', { recipientId: recipient.id, campaignId: recipient.campaign_id, externalMessageId }).catch(() => undefined);
      await completeCampaignIfFinished(recipient.campaign_id, recipient.tenant_id);
      return { externalMessageId };
    } catch (error) {
      if (usageReserved && usageDate) await releaseDailyUsage(input.instanceId, usageDate);
      throw error;
    } finally {
      await lock.release();
    }
  };
}

async function persistAcceptedMessage(recipient: RecipientRow, externalMessageId: string, usageDate: string): Promise<void> {
  const encrypted = encryptText(recipient.rendered_message);
  const client = await connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE campaign_recipients SET status = 'SENT', external_message_id = $2,
              sent_at = now(), failure_code = NULL, failure_message = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $3 AND status NOT IN ('SENT', 'DELIVERED', 'READ')
       RETURNING id`,
      [recipient.id, externalMessageId, recipient.tenant_id],
    );
    if (updated.rows[0]) {
      await client.query(
        `INSERT INTO messages
           (tenant_id, instance_id, campaign_id, contact_id, direction, type, status,
            external_message_id, content_ciphertext, content_iv, content_tag, sent_at)
         VALUES ($1, $2, $3, $4, 'OUTBOUND', 'TEXT', 'SENT', $5, $6, $7, $8, now())
         ON CONFLICT (instance_id, external_message_id) DO NOTHING`,
        [recipient.tenant_id, recipient.instance_id, recipient.campaign_id, recipient.contact_id, externalMessageId, encrypted.ciphertext, encrypted.iv, encrypted.tag],
      );
      await client.query(
        `INSERT INTO daily_usage (tenant_id, instance_id, date, timezone, allowed, sent)
         VALUES ($1, $2, $3, $4, $5, 1)
         ON CONFLICT (instance_id, date) DO UPDATE SET sent = daily_usage.sent + 1, allowed = EXCLUDED.allowed, updated_at = now()`,
        [recipient.tenant_id, recipient.instance_id, usageDate, recipient.timezone, recipient.daily_limit],
      );
      await client.query(
        'UPDATE campaigns SET sent_count = sent_count + 1, updated_at = now() WHERE id = $1 AND tenant_id = $2',
        [recipient.campaign_id, recipient.tenant_id],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function completeCampaignIfFinished(campaignId: string, tenantId: string): Promise<void> {
  const completed = await query<{ id: string }>(
    `UPDATE campaigns c SET status = 'COMPLETED', completed_at = now(), updated_at = now()
     WHERE c.id = $1 AND c.tenant_id = $2 AND c.status = 'RUNNING'
       AND NOT EXISTS (
         SELECT 1 FROM campaign_recipients r
         WHERE r.campaign_id = c.id AND r.tenant_id = c.tenant_id
           AND r.status IN ('PENDING', 'QUEUED', 'SENDING', 'DEFERRED')
       ) RETURNING id`,
    [campaignId, tenantId],
  );
  if (completed[0]) await emitWebhookEvent(tenantId, 'campaign.completed', { id: campaignId }).catch(() => undefined);
}
