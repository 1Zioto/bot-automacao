import { DelayedError, type Job } from 'bullmq';
import { getPool, query } from '@autoflow/database';
import { emitWebhookEvent } from '@autoflow/events';
import {
  directOutboundMessageJobSchema,
  DistributedLock,
  getRedis,
  releaseDailyUsage,
  reserveDailyUsage,
  type DirectOutboundMessageJob,
} from '@autoflow/queue';
import { decryptText } from '@autoflow/security';
import { AppError, localDateKey } from '@autoflow/shared';
import type { InstanceManager } from './instance-manager.js';
import { isInsideWindow, localClock } from './sending-window.js';

interface DirectMessageRow {
  id: string;
  tenant_id: string;
  instance_id: string;
  contact_id: string;
  status: string;
  recipient_phone_snapshot: string;
  content_ciphertext: Buffer;
  content_iv: Buffer;
  content_tag: Buffer;
  consent_status: string;
  opted_out_at: Date | null;
  blocked_at: Date | null;
  timezone: string;
  daily_limit: number;
}

export function createDirectOutboundProcessor(manager: InstanceManager) {
  return async (job: Job<DirectOutboundMessageJob>, token?: string): Promise<{ externalMessageId?: string; skipped?: string }> => {
    const input = directOutboundMessageJobSchema.parse(job.data);
    const lock = new DistributedLock(`wa:instance:${input.instanceId}:send`, 120_000);
    if (!(await lock.acquire())) throw new AppError('INSTANCE_BUSY', 'Instancia processando outro envio.', 503);
    let usageDate: string | undefined;
    let usageReserved = false;
    try {
      const rows = await query<DirectMessageRow>(
        `SELECT m.id, m.tenant_id, m.instance_id, m.contact_id, m.status,
                m.recipient_phone_snapshot, m.content_ciphertext, m.content_iv, m.content_tag,
                ct.consent_status, ct.opted_out_at, ct.blocked_at, t.timezone,
                COALESCE(i.daily_limit_override, p.daily_messages_per_instance) AS daily_limit
         FROM messages m
         JOIN contacts ct ON ct.tenant_id = m.tenant_id AND ct.id = m.contact_id
         JOIN whatsapp_instances i ON i.tenant_id = m.tenant_id AND i.id = m.instance_id
         JOIN tenants t ON t.id = m.tenant_id
         JOIN subscriptions s ON s.tenant_id = m.tenant_id AND s.status IN ('TRIALING', 'ACTIVE', 'GRACE_PERIOD')
         JOIN plans p ON p.id = s.plan_id
         WHERE m.id = $1 AND m.tenant_id = $2 AND m.instance_id = $3
           AND m.direction = 'OUTBOUND' AND m.campaign_id IS NULL`,
        [input.messageId, input.tenantId, input.instanceId],
      );
      const message = rows[0];
      if (!message) throw new AppError('MESSAGE_NOT_FOUND', 'Mensagem nao encontrada.', 404);
      if (['SENT', 'DELIVERED', 'READ'].includes(message.status)) return { skipped: 'ALREADY_SENT' };
      if (message.consent_status !== 'GRANTED' || message.opted_out_at || message.blocked_at) {
        await query("UPDATE messages SET status = 'SKIPPED', error_code = 'NO_CONSENT' WHERE id = $1 AND tenant_id = $2", [message.id, message.tenant_id]);
        return { skipped: 'NO_CONSENT' };
      }

      const acceptedCacheKey = `wa:direct:accepted:${input.idempotencyKey}`;
      const acceptedCache = await getRedis().get(acceptedCacheKey);
      if (acceptedCache) {
        const accepted = JSON.parse(acceptedCache) as { externalMessageId: string; usageDate: string };
        await persistDirectMessage(message, accepted.externalMessageId, accepted.usageDate);
        await getRedis().del(acceptedCacheKey);
        await emitWebhookEvent(message.tenant_id, 'message.sent', { id: message.id, externalMessageId: accepted.externalMessageId }).catch(() => undefined);
        return { externalMessageId: accepted.externalMessageId };
      }

      const windows = await query<{ day_of_week: number; start_time: string | null; end_time: string | null; enabled: boolean }>(
        `SELECT day_of_week, start_time::text, end_time::text, enabled
         FROM sending_windows WHERE tenant_id = $1 AND instance_id = $2`,
        [message.tenant_id, message.instance_id],
      );
      if (windows.length > 0 && !windows.some((window) => isInsideWindow(localClock(new Date(), message.timezone), window))) {
        if (!token) throw new AppError('MISSING_JOB_TOKEN', 'Token do job ausente.', 500);
        await job.moveToDelayed(Date.now() + 5 * 60_000, token);
        throw new DelayedError();
      }
      if (!manager.hasReadyClient(message.instance_id)) {
        if (!token) throw new AppError('MISSING_JOB_TOKEN', 'Token do job ausente.', 500);
        await job.moveToDelayed(Date.now() + 15_000, token);
        throw new DelayedError();
      }

      usageDate = localDateKey(new Date(), message.timezone);
      const usage = await reserveDailyUsage(message.instance_id, usageDate, message.daily_limit);
      if (!usage.allowed) {
        const firstNotice = await getRedis().set(`usage:limit-event:${message.instance_id}:${usageDate}`, '1', 'PX', 172_800_000, 'NX');
        if (firstNotice) await emitWebhookEvent(message.tenant_id, 'usage.daily_limit_reached', { instanceId: message.instance_id, date: usageDate, limit: message.daily_limit }).catch(() => undefined);
        if (!token) throw new AppError('MISSING_JOB_TOKEN', 'Token do job ausente.', 500);
        await job.moveToDelayed(Date.now() + 15 * 60_000, token);
        throw new DelayedError();
      }
      usageReserved = true;
      await query("UPDATE messages SET status = 'SENDING', error_code = NULL WHERE id = $1 AND tenant_id = $2", [message.id, message.tenant_id]);
      const text = decryptText({ ciphertext: message.content_ciphertext, iv: message.content_iv, tag: message.content_tag });
      const externalMessageId = await manager.sendText(message.instance_id, message.recipient_phone_snapshot, text);
      await getRedis().set(acceptedCacheKey, JSON.stringify({ externalMessageId, usageDate }), 'EX', 7 * 24 * 60 * 60);
      usageReserved = false;
      await persistDirectMessage(message, externalMessageId, usageDate);
      await getRedis().del(acceptedCacheKey);
      await emitWebhookEvent(message.tenant_id, 'message.sent', { id: message.id, externalMessageId }).catch(() => undefined);
      return { externalMessageId };
    } catch (error) {
      if (usageReserved && usageDate) await releaseDailyUsage(input.instanceId, usageDate);
      throw error;
    } finally {
      await lock.release();
    }
  };
}

async function persistDirectMessage(message: DirectMessageRow, externalMessageId: string, usageDate: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE messages SET status = 'SENT', external_message_id = $2, sent_at = now(), error_code = NULL
       WHERE id = $1 AND tenant_id = $3 AND status NOT IN ('SENT', 'DELIVERED', 'READ') RETURNING id`,
      [message.id, externalMessageId, message.tenant_id],
    );
    if (updated.rows[0]) {
      await client.query(
        `INSERT INTO daily_usage (tenant_id, instance_id, date, timezone, allowed, sent)
         VALUES ($1, $2, $3, $4, $5, 1)
         ON CONFLICT (instance_id, date) DO UPDATE
           SET sent = daily_usage.sent + 1, allowed = EXCLUDED.allowed, updated_at = now()`,
        [message.tenant_id, message.instance_id, usageDate, message.timezone, message.daily_limit],
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
