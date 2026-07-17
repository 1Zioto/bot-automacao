import type { Request } from 'express';
import { query } from '@autoflow/database';
import type { AuthenticatedRequest, RequestContextRequest } from './types.js';

interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string;
  oldValues?: unknown;
  newValues?: unknown;
}

export async function recordAudit(req: Request, input: AuditInput): Promise<void> {
  const auth = (req as AuthenticatedRequest).auth;
  const requestId = (req as RequestContextRequest).requestId;
  await query(
    `INSERT INTO audit_logs
       (tenant_id, user_id, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent, request_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
    [
      auth.tenantId,
      auth.userId,
      input.action,
      input.entityType,
      input.entityId ?? null,
      input.oldValues === undefined ? null : JSON.stringify(input.oldValues),
      input.newValues === undefined ? null : JSON.stringify(input.newValues),
      req.ip,
      req.headers['user-agent'] ?? null,
      requestId,
    ],
  );
}
