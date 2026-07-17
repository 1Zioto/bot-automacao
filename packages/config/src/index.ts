import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  DATABASE_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/).default('saas'),
  REDIS_URL: z.string().min(1),
  ACCESS_TOKEN_SECRET: z.string().min(32),
  REFRESH_TOKEN_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().min(32),
  PUBLIC_APP_URL: z.string().url(),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  WHATSAPP_SESSION_PATH: z.string().default('.data/whatsapp-sessions'),
  WHATSAPP_HEADLESS: booleanFromString,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Environment = z.infer<typeof environmentSchema>;

let cached: Environment | undefined;

export function getEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  cached ??= environmentSchema.parse(source);
  return cached;
}

export function resetEnvironmentForTests(): void {
  cached = undefined;
}
