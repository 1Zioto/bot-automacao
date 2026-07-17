import pino, { type LoggerOptions } from 'pino';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'password',
  'passwordHash',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
  'qr',
  'session',
  '*.password',
  '*.token',
  '*.secret',
  '*.qr',
];

export function createLogger(options: LoggerOptions = {}) {
  const merged = {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: { paths: redactPaths, censor: '[REDACTED]' },
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    ...options,
  } as LoggerOptions;
  return pino(merged);
}

export type AppLogger = ReturnType<typeof createLogger>;
