import { getEnvironment } from '@autoflow/config';
import { closePool } from '@autoflow/database';
import { createLogger } from '@autoflow/logger';
import { createApp } from './app.js';

const env = getEnvironment();
const logger = createLogger({ name: 'api-server' });
const server = createApp().listen(env.API_PORT, () => logger.info({ port: env.API_PORT }, 'API iniciada'));

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Encerrando API');
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
