import { randomUUID } from 'node:crypto';
import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { getEnvironment } from '@autoflow/config';

export const queueNames = {
  campaignPreparation: 'campaign-preparation',
  outboundMessages: 'outbound-messages',
  directOutboundMessages: 'direct-outbound-messages',
  messageStatus: 'message-status',
  webhookDeliveries: 'webhook-deliveries',
  instanceLifecycle: 'instance-lifecycle',
  contactImports: 'contact-imports',
  reports: 'reports',
  cleanup: 'cleanup',
} as const;

export const outboundMessageJobSchema = z.object({
  tenantId: z.uuid(),
  instanceId: z.uuid(),
  recipientId: z.uuid(),
  idempotencyKey: z.string().min(8),
});
export type OutboundMessageJob = z.infer<typeof outboundMessageJobSchema>;

export const directOutboundMessageJobSchema = z.object({
  tenantId: z.uuid(),
  instanceId: z.uuid(),
  messageId: z.uuid(),
  idempotencyKey: z.string().min(8),
});
export type DirectOutboundMessageJob = z.infer<typeof directOutboundMessageJobSchema>;

export const campaignPreparationJobSchema = z.object({
  tenantId: z.uuid(),
  campaignId: z.uuid(),
  requestedBy: z.uuid(),
});
export type CampaignPreparationJob = z.infer<typeof campaignPreparationJobSchema>;

export const instanceLifecycleJobSchema = z.object({
  tenantId: z.uuid(),
  instanceId: z.uuid(),
  action: z.enum(['INITIALIZE', 'RECONNECT', 'PAUSE', 'RESUME', 'DELETE_SESSION', 'DESTROY']),
});
export type InstanceLifecycleJob = z.infer<typeof instanceLifecycleJobSchema>;

export const contactImportJobSchema = z.object({
  tenantId: z.uuid(),
  instanceId: z.uuid(),
  requestedBy: z.uuid(),
});
export type ContactImportJob = z.infer<typeof contactImportJobSchema>;

export const webhookDeliveryJobSchema = z.object({
  tenantId: z.uuid(),
  deliveryId: z.uuid(),
});
export type WebhookDeliveryJob = z.infer<typeof webhookDeliveryJobSchema>;

let redis: Redis | undefined;

export function isRedisEnabled(): boolean {
  if (process.env.USE_REDIS === 'true') {
    const url = (process.env.REDIS_URL || getEnvironment().REDIS_URL || '').trim();
    return Boolean(url);
  }
  return false;
}

export function getRedis(): Redis {
  if (!isRedisEnabled()) {
    return {
      set: async () => 'OK',
      get: async () => null,
      del: async () => 1,
      eval: async () => 1,
      quit: async () => {},
      on: () => {},
    } as unknown as Redis;
  }
  if (!redis) {
    const url = getEnvironment().REDIS_URL || 'redis://127.0.0.1:6379';
    redis = new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy: () => null,
      reconnectOnError: () => false,
      connectTimeout: 1000,
    });
    redis.on('error', () => {});
  }
  return redis;
}

const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 86_400, count: 10_000 },
  removeOnFail: { age: 604_800, count: 10_000 },
};

export function createQueue<T>(name: string): Queue<T> {
  if (!isRedisEnabled()) {
    return {
      add: async () => ({ id: 'direct-db-mode' } as any),
      addBulk: async () => ([] as any),
      close: async () => {},
    } as unknown as Queue<T>;
  }
  return new Queue<T>(name, { connection: getRedis(), defaultJobOptions });
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    try {
      await redis.quit();
    } catch {}
  }
  redis = undefined;
}

const acquireScript = `
  if redis.call('exists', KEYS[1]) == 0 then
    redis.call('psetex', KEYS[1], ARGV[2], ARGV[1])
    return 1
  end
  return 0
`;
const renewScript = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('pexpire', KEYS[1], ARGV[2])
  end
  return 0
`;
const releaseScript = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  end
  return 0
`;

export class DistributedLock {
  public readonly token = randomUUID();

  constructor(
    private readonly key: string,
    private readonly ttlMs: number,
    private readonly client = isRedisEnabled() ? getRedis() : null,
  ) {}

  async acquire(): Promise<boolean> {
    if (!this.client || !isRedisEnabled()) return true;
    try {
      return Number(await this.client.eval(acquireScript, 1, this.key, this.token, this.ttlMs)) === 1;
    } catch {
      return true;
    }
  }

  async renew(): Promise<boolean> {
    if (!this.client || !isRedisEnabled()) return true;
    try {
      return Number(await this.client.eval(renewScript, 1, this.key, this.token, this.ttlMs)) === 1;
    } catch {
      return true;
    }
  }

  async release(): Promise<boolean> {
    if (!this.client || !isRedisEnabled()) return true;
    try {
      return Number(await this.client.eval(releaseScript, 1, this.key, this.token)) === 1;
    } catch {
      return true;
    }
  }
}

const reserveDailyUsageScript = `
  local current = tonumber(redis.call('get', KEYS[1]) or '0')
  local limit = tonumber(ARGV[1])
  if current >= limit then return {0, current} end
  current = redis.call('incr', KEYS[1])
  if current == 1 then redis.call('pexpire', KEYS[1], ARGV[2]) end
  return {1, current}
`;

export async function reserveDailyUsage(instanceId: string, localDate: string, limit: number, ttlMs = 172_800_000): Promise<{ allowed: boolean; current: number }> {
  if (!isRedisEnabled()) return { allowed: true, current: 0 };
  const key = `usage:${instanceId}:${localDate}`;
  try {
    const result = (await getRedis().eval(reserveDailyUsageScript, 1, key, limit, ttlMs)) as [number, number];
    return { allowed: Number(result[0]) === 1, current: Number(result[1]) };
  } catch {
    return { allowed: true, current: 0 };
  }
}

const releaseDailyUsageScript = `
  local current = tonumber(redis.call('get', KEYS[1]) or '0')
  if current <= 0 then return 0 end
  return redis.call('decr', KEYS[1])
`;

export async function releaseDailyUsage(instanceId: string, localDate: string): Promise<number> {
  if (!isRedisEnabled()) return 0;
  try {
    return Number(await getRedis().eval(releaseDailyUsageScript, 1, `usage:${instanceId}:${localDate}`));
  } catch {
    return 0;
  }
}
