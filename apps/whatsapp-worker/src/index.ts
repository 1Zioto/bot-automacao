import { Worker } from 'bullmq';
import { closePool, query } from '@autoflow/database';
import { emitWebhookEvent } from '@autoflow/events';
import { createLogger } from '@autoflow/logger';
import { closeRedis, getRedis, queueNames, type ContactImportJob, type DirectOutboundMessageJob, type OutboundMessageJob } from '@autoflow/queue';
import { createContactImportProcessor } from './contact-import-processor.js';
import { createDirectOutboundProcessor } from './direct-outbound-processor.js';
import { InstanceManager } from './instance-manager.js';
import { createOutboundProcessor } from './outbound-processor.js';

const logger = createLogger({ name: 'whatsapp-worker' });
const manager = new InstanceManager();
manager.start();
let outboundWorker: Worker<OutboundMessageJob> | undefined;
let directOutboundWorker: Worker<DirectOutboundMessageJob> | undefined;
let contactImportWorker: Worker<ContactImportJob> | undefined;

async function initBullMQWorkers(): Promise<void> {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl || redisUrl.includes('127.0.0.1')) {
    logger.info('Modo Direto PostgreSQL ativo (sem Redis)');
    return;
  }
  try {
    const redis = getRedis();
    await redis.ping();

    outboundWorker = new Worker<OutboundMessageJob>(
      queueNames.outboundMessages,
      createOutboundProcessor(manager),
      { connection: redis, concurrency: 10 },
    );
    directOutboundWorker = new Worker<DirectOutboundMessageJob>(
      queueNames.directOutboundMessages,
      createDirectOutboundProcessor(manager),
      { connection: redis, concurrency: 10 },
    );
    contactImportWorker = new Worker<ContactImportJob>(
      queueNames.contactImports,
      createContactImportProcessor(manager),
      { connection: redis, concurrency: 1 },
    );

    outboundWorker.on('error', () => {});
    directOutboundWorker.on('error', () => {});
    contactImportWorker.on('error', () => {});

    outboundWorker.on('failed', (job, error) => {
      logger.warn({ err: error, jobId: job?.id, recipientId: job?.data.recipientId }, 'Falha de envio');
    });
    directOutboundWorker.on('failed', (job, error) => {
      logger.warn({ err: error, jobId: job?.id, messageId: job?.data.messageId }, 'Falha de envio direto');
    });

    logger.info('Filas BullMQ conectadas via Redis');
  } catch {
    logger.info('Modo direto PostgreSQL ativo (sem Redis)');
  }
}

void initBullMQWorkers();

process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

logger.info('WhatsApp worker iniciado');

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Encerrando WhatsApp worker');
  if (outboundWorker) {
    await outboundWorker.pause();
    await outboundWorker.close();
  }
  if (directOutboundWorker) {
    await directOutboundWorker.pause();
    await directOutboundWorker.close();
  }
  if (contactImportWorker) {
    await contactImportWorker.pause();
    await contactImportWorker.close();
  }
  await manager.shutdown();
  await closePool();
  await closeRedis();
}

process.on('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(0)));
process.on('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(0)));
