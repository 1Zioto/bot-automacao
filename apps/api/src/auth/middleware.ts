import type { NextFunction, Request, Response } from 'express';
import { roleSchema } from '@autoflow/contracts';
import { query } from '@autoflow/database';
import { AppError } from '@autoflow/shared';
import type { AuthenticatedRequest } from '../types.js';
import { roleHasPermission, type Permission } from './permissions.js';
import { verifyAccessToken } from './tokens.js';

interface MembershipRow {
  membership_id: string;
  role: string;
  email: string;
}

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization ?? '';
    const token = header.replace(/^Bearer\s+/i, '');
    if (!token || token === header) throw new AppError('AUTH_REQUIRED', 'Autenticacao obrigatoria.', 401);
    const claims = await verifyAccessToken(token);

    const rows = await query<MembershipRow>(
      `SELECT m.id AS membership_id, m.role, u.email
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       JOIN tenants t ON t.id = m.tenant_id
       WHERE m.id = $1 AND m.user_id = $2 AND m.tenant_id = $3
         AND m.status = 'ACTIVE' AND u.status = 'ACTIVE' AND t.status IN ('TRIAL', 'ACTIVE')`,
      [claims.membershipId, claims.userId, claims.tenantId],
    );
    const membership = rows[0];
    if (!membership) throw new AppError('SESSION_REVOKED', 'Acesso revogado.', 401);

    (req as AuthenticatedRequest).auth = {
      userId: claims.userId,
      tenantId: claims.tenantId,
      membershipId: membership.membership_id,
      role: roleSchema.parse(membership.role),
      email: membership.email,
    };
    next();
  } catch (error) {
    next(error);
  }
}

export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const { role } = (req as AuthenticatedRequest).auth;
    if (!roleHasPermission(role, permission)) {
      next(new AppError('FORBIDDEN', 'Permissao insuficiente.', 403));
      return;
    }
    next();
  };
}
