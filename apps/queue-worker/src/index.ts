import { Worker } from 'bullmq';
import { closePool, query } from '@autoflow/database';
import { createLogger } from '@autoflow/logger';
import {
  closeRedis,
  getRedis,
  queueNames,
  type CampaignPreparationJob,
  type WebhookDeliveryJob,
} from '@autoflow/queue';
import { processCampaignPreparation } from './campaign-processor.js';
import { processWebhookDelivery } from './webhook-processor.js';

const logger = createLogger({ name: 'queue-worker' });
const campaignWorker = new Worker<CampaignPreparationJob>(
  queueNames.campaignPreparation,
  processCampaignPreparation,
  { connection: getRedis(), concurrency: 2 },
);
const webhookWorker = new Worker<WebhookDeliveryJob>(
  queueNames.webhookDeliveries,
  processWebhookDelivery,
  { connection: getRedis(), concurrency: 10 },
);

campaignWorker.on('failed', (job, error) => {
  logger.error({ err: error, jobId: job?.id, campaignId: job?.data.campaignId }, 'Falha ao preparar campanha');
  if (job) {
    void query(
      `UPDATE campaigns SET status = 'ERROR', updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'PREPARING'`,
      [job.data.campaignId, job.data.tenantId],
    );
  }
});
webhookWorker.on('failed', (job, error) => {
  logger.warn({ err: error, jobId: job?.id }, 'Falha na entrega de webhook');
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    void query(
      `WITH failed AS (
         UPDATE webhook_deliveries
         SET status = 'FAILED', next_attempt_at = NULL
         WHERE id = $1 AND tenant_id = $2
         RETURNING webhook_endpoint_id
       )
       UPDATE webhook_endpoints e
       SET consecutive_failures = consecutive_failures + 1,
           status = CASE WHEN consecutive_failures + 1 >= 10 THEN 'DISABLED' ELSE status END,
           updated_at = now()
       FROM failed WHERE e.id = failed.webhook_endpoint_id AND e.tenant_id = $2`,
      [job.data.deliveryId, job.data.tenantId],
    );
  }
});
logger.info('Workers de campanha e webhooks iniciados');

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Encerrando queue worker');
  await Promise.all([campaignWorker.close(), webhookWorker.close()]);
  await closePool();
  await closeRedis();
}

process.on('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(0)));
process.on('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(0)));
