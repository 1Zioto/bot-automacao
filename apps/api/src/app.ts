import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { ZodError } from 'zod';
import { getEnvironment } from '@autoflow/config';
import { query } from '@autoflow/database';
import { createLogger } from '@autoflow/logger';
import { AppError } from '@autoflow/shared';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { apiKeysRouter } from './routes/api-keys.js';
import { billingRouter, catalogRouter } from './routes/billing.js';
import { campaignsRouter } from './routes/campaigns.js';
import { contactsRouter } from './routes/contacts.js';
import { instancesRouter } from './routes/instances.js';
import { listsRouter } from './routes/lists.js';
import { messagesRouter } from './routes/messages.js';
import { teamRouter } from './routes/team.js';
import { webhooksRouter } from './routes/webhooks.js';
import type { RequestContextRequest } from './types.js';

const logger = createLogger({ name: 'api' });

export function createApp(): Express {
  const env = getEnvironment();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS.split(',').map((item) => item.trim()), credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    const requestId = String(req.headers['x-request-id'] ?? randomUUID());
    (req as RequestContextRequest).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  });
  app.use(pinoHttp({ logger }));
  app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/live', (_req, res) => res.json({ status: 'alive' }));
  app.get('/health/ready', async (_req, res, next) => {
    try {
      await query('SELECT 1');
      res.json({ status: 'ready' });
    } catch (error) {
      next(new AppError('NOT_READY', 'Dependencias indisponiveis.', 503, error));
    }
  });

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1/plans', catalogRouter);
  app.use('/api/v1/billing', billingRouter);
  app.use('/api/v1/instances', instancesRouter);
  app.use('/api/v1/contacts', contactsRouter);
  app.use('/api/v1/lists', listsRouter);
  app.use('/api/v1/messages', messagesRouter);
  app.use('/api/v1/team', teamRouter);
  app.use('/api/v1/campaigns', campaignsRouter);
  app.use('/api/v1/api-keys', apiKeysRouter);
  app.use('/api/v1/webhooks', webhooksRouter);

  app.use((_req, _res, next) => next(new AppError('NOT_FOUND', 'Rota nao encontrada.', 404)));
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Dados invalidos.', details: error.issues }, requestId: (req as RequestContextRequest).requestId });
      return;
    }
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: { code: error.code, message: error.message, details: error.details }, requestId: (req as RequestContextRequest).requestId });
      return;
    }
    req.log.error({ err: error }, 'Erro nao tratado');
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno.' }, requestId: (req as RequestContextRequest).requestId });
  });
  return app;
}
