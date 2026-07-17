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

export const webhookDeliveryJobSchema = z.object({
  tenantId: z.uuid(),
  deliveryId: z.uuid(),
});
export type WebhookDeliveryJob = z.infer<typeof webhookDeliveryJobSchema>;

let redis: Redis | undefined;

export function getRedis(): Redis {
  redis ??= new Redis(getEnvironment().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  });
  return redis;
}

const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 86_400, count: 10_000 },
  removeOnFail: { age: 604_800, count: 10_000 },
};

export function createQueue<T>(name: string): Queue<T> {
  return new Queue<T>(name, { connection: getRedis(), defaultJobOptions });
}

export async function closeRedis(): Promise<void> {
  if (redis) await redis.quit();
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
    private readonly client = getRedis(),
  ) {}

  async acquire(): Promise<boolean> {
    return Number(await this.client.eval(acquireScript, 1, this.key, this.token, this.ttlMs)) === 1;
  }

  async renew(): Promise<boolean> {
    return Number(await this.client.eval(renewScript, 1, this.key, this.token, this.ttlMs)) === 1;
  }

  async release(): Promise<boolean> {
    return Number(await this.client.eval(releaseScript, 1, this.key, this.token)) === 1;
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
  const key = `usage:${instanceId}:${localDate}`;
  const result = (await getRedis().eval(reserveDailyUsageScript, 1, key, limit, ttlMs)) as [number, number];
  return { allowed: Number(result[0]) === 1, current: Number(result[1]) };
}

const releaseDailyUsageScript = `
  local current = tonumber(redis.call('get', KEYS[1]) or '0')
  if current <= 0 then return 0 end
  return redis.call('decr', KEYS[1])
`;

export async function releaseDailyUsage(instanceId: string, localDate: string): Promise<number> {
  return Number(await getRedis().eval(releaseDailyUsageScript, 1, `usage:${instanceId}:${localDate}`));
}
