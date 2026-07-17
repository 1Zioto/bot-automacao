import type { NextFunction, Request, Response } from 'express';
import { query } from '@autoflow/database';
import { AppError } from '@autoflow/shared';
import type { AuthenticatedRequest } from '../types.js';

export async function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const rows = await query('SELECT 1 FROM platform_admins WHERE user_id = $1', [auth.userId]);
    if (!rows[0]) throw new AppError('PLATFORM_ADMIN_REQUIRED', 'Acesso administrativo global obrigatorio.', 403);
    next();
  } catch (error) {
    next(error);
  }
}
