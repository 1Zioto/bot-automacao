import { Worker } from 'bullmq';
import { closePool, query } from '@autoflow/database';
import { emitWebhookEvent } from '@autoflow/events';
import { createLogger } from '@autoflow/logger';
import { closeRedis, getRedis, queueNames, type DirectOutboundMessageJob, type OutboundMessageJob } from '@autoflow/queue';
import { createDirectOutboundProcessor } from './direct-outbound-processor.js';
import { InstanceManager } from './instance-manager.js';
import { createOutboundProcessor } from './outbound-processor.js';

const logger = createLogger({ name: 'whatsapp-worker' });
const manager = new InstanceManager();
manager.start();
const outboundWorker = new Worker<OutboundMessageJob>(
  queueNames.outboundMessages,
  createOutboundProcessor(manager),
  { connection: getRedis(), concurrency: 10 },
);
const directOutboundWorker = new Worker<DirectOutboundMessageJob>(
  queueNames.directOutboundMessages,
  createDirectOutboundProcessor(manager),
  { connection: getRedis(), concurrency: 10 },
);

outboundWorker.on('failed', (job, error) => {
  logger.warn({ err: error, jobId: job?.id, recipientId: job?.data.recipientId }, 'Falha de envio');
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    void (async () => {
      const failed = await query<{ id: string }>(
        `WITH failed_recipient AS (
           UPDATE campaign_recipients SET status = 'FAILED', failed_at = now(),
                  failure_code = 'RETRIES_EXHAUSTED', failure_message = $3, updated_at = now()
           WHERE id = $1 AND tenant_id = $2 AND status NOT IN ('SENT', 'DELIVERED', 'READ', 'FAILED')
           RETURNING campaign_id, tenant_id
         )
         UPDATE campaigns c SET failed_count = failed_count + 1, updated_at = now()
         FROM failed_recipient f WHERE c.id = f.campaign_id AND c.tenant_id = f.tenant_id
         RETURNING c.id`,
        [job.data.recipientId, job.data.tenantId, error.message.slice(0, 500)],
      );
      if (!failed[0]) return;
      await emitWebhookEvent(job.data.tenantId, 'message.failed', { recipientId: job.data.recipientId, campaignId: failed[0].id, code: 'RETRIES_EXHAUSTED' }).catch(() => undefined);
      const completed = await query<{ id: string }>(
        `UPDATE campaigns c SET status = 'COMPLETED', completed_at = now(), updated_at = now()
         WHERE c.id = $1 AND c.tenant_id = $2 AND c.status = 'RUNNING'
           AND NOT EXISTS (
             SELECT 1 FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.tenant_id = c.tenant_id
               AND r.status IN ('PENDING', 'QUEUED', 'SENDING', 'DEFERRED')
           ) RETURNING id`,
        [failed[0].id, job.data.tenantId],
      );
      if (completed[0]) await emitWebhookEvent(job.data.tenantId, 'campaign.completed', { id: completed[0].id }).catch(() => undefined);
    })();
  }
});
directOutboundWorker.on('failed', (job, error) => {
  logger.warn({ err: error, jobId: job?.id, messageId: job?.data.messageId }, 'Falha de envio direto');
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    void query<{ id: string }>(
      `UPDATE messages SET status = 'FAILED', error_code = 'RETRIES_EXHAUSTED',
              metadata = metadata || jsonb_build_object('failureMessage', $3::text)
       WHERE id = $1 AND tenant_id = $2 AND status NOT IN ('SENT', 'DELIVERED', 'READ', 'FAILED')
       RETURNING id`,
      [job.data.messageId, job.data.tenantId, error.message.slice(0, 500)],
    ).then((rows) => rows[0]
      ? emitWebhookEvent(job.data.tenantId, 'message.failed', { id: job.data.messageId, code: 'RETRIES_EXHAUSTED' }).then(() => undefined)
      : undefined);
  }
});
logger.info('WhatsApp worker iniciado');

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Encerrando WhatsApp worker');
  await outboundWorker.pause();
  await directOutboundWorker.pause();
  await outboundWorker.close();
  await directOutboundWorker.close();
  await manager.shutdown();
  await closePool();
  await closeRedis();
}

process.on('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(0)));
process.on('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(0)));
