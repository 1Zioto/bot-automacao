import { emitWebhookEvent, type WebhookEventType } from '@autoflow/events';
import { createLogger } from '@autoflow/logger';

const logger = createLogger({ name: 'api-events' });

export async function emitEventSafely(tenantId: string, type: WebhookEventType, data: unknown): Promise<void> {
  try {
    await emitWebhookEvent(tenantId, type, data);
  } catch (error) {
    logger.warn({ err: error, tenantId, type }, 'Evento de webhook ficou pendente');
  }
}
