import type { NextFunction, Request, Response } from 'express';
import { query } from '@autoflow/database';
import { hashApiKey } from '@autoflow/security';
import { AppError } from '@autoflow/shared';
import type { ApiKeyRequest } from '../types.js';

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  scopes: string[];
}

function readApiKey(req: Request): string {
  const header = req.headers.authorization ?? '';
  const bearer = header.replace(/^Bearer\s+/i, '');
  if (bearer && bearer !== header) return bearer;
  const explicit = req.headers['x-api-key'];
  return Array.isArray(explicit) ? (explicit[0] ?? '') : (explicit ?? '');
}

export function authenticateApiKey(requiredScope: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = readApiKey(req);
      if (!key.startsWith('wa_live_')) throw new AppError('API_KEY_REQUIRED', 'Chave de API obrigatoria.', 401);
      const rows = await query<ApiKeyRow>(
        `SELECT k.id, k.tenant_id, k.scopes
         FROM api_keys k
         JOIN tenants t ON t.id = k.tenant_id
         JOIN subscriptions s ON s.tenant_id = k.tenant_id
           AND s.status IN ('TRIALING', 'ACTIVE', 'GRACE_PERIOD')
         JOIN plans p ON p.id = s.plan_id AND p.api_access_level != 'NONE'
         WHERE k.key_hash = $1 AND k.revoked_at IS NULL
           AND (k.expires_at IS NULL OR k.expires_at > now())
           AND t.status IN ('TRIAL', 'ACTIVE')
         LIMIT 1`,
        [hashApiKey(key)],
      );
      const apiKey = rows[0];
      if (!apiKey) throw new AppError('INVALID_API_KEY', 'Chave de API invalida ou expirada.', 401);
      if (!apiKey.scopes.includes(requiredScope)) throw new AppError('MISSING_SCOPE', `Escopo obrigatorio: ${requiredScope}.`, 403);
      (req as ApiKeyRequest).apiAuth = {
        apiKeyId: apiKey.id,
        tenantId: apiKey.tenant_id,
        scopes: apiKey.scopes,
      };
      await query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [apiKey.id]);
      next();
    } catch (error) {
      next(error);
    }
  };
}
