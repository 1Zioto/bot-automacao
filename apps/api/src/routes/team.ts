import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { roleSchema } from '@autoflow/contracts';
import { query } from '@autoflow/database';
import { hashApiKey } from '@autoflow/security';
import { AppError } from '@autoflow/shared';
import { recordAudit } from '../audit.js';
import { authenticate, requirePermission } from '../auth/middleware.js';
import type { AuthenticatedRequest } from '../types.js';

const inviteSchema = z.object({ email: z.email(), role: roleSchema });
const roleUpdateSchema = z.object({ role: roleSchema });
const statusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) });
const router: Router = Router();
router.use(authenticate, requirePermission('users.manage'));

router.get('/', async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const members = await query(
      `SELECT m.id, u.name, u.email, m.role, m.status, m.accepted_at, m.created_at
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = $1 AND m.status != 'REMOVED'
       ORDER BY m.created_at`,
      [auth.tenantId],
    );
    const invitations = await query(
      `SELECT id, email, role, status, expires_at, created_at
       FROM membership_invitations WHERE tenant_id = $1 AND status = 'PENDING'
       ORDER BY created_at DESC`,
      [auth.tenantId],
    );
    res.json({ members, invitations });
  } catch (error) {
    next(error);
  }
});

router.post('/invitations', async (req, res, next) => {
  try {
    const input = inviteSchema.parse(req.body);
    const auth = (req as AuthenticatedRequest).auth;
    if (input.role === 'OWNER' && auth.role !== 'OWNER') throw new AppError('FORBIDDEN_ROLE', 'Somente o proprietario pode convidar outro proprietario.', 403);
    const limits = await query<{ max_users: number; used: number }>(
      `SELECT COALESCE((s.custom_limits->>'maxUsers')::int, p.max_users) AS max_users,
              ((SELECT COUNT(*) FROM memberships m WHERE m.tenant_id = s.tenant_id AND m.status IN ('ACTIVE', 'INVITED', 'SUSPENDED')) +
               (SELECT COUNT(*) FROM membership_invitations i WHERE i.tenant_id = s.tenant_id AND i.status = 'PENDING'))::int AS used
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.tenant_id = $1 AND s.status IN ('TRIALING', 'ACTIVE', 'GRACE_PERIOD')`,
      [auth.tenantId],
    );
    if (!limits[0]) throw new AppError('SUBSCRIPTION_REQUIRED', 'Assinatura ativa obrigatoria.', 402);
    if (limits[0].used >= limits[0].max_users) throw new AppError('USER_LIMIT_REACHED', 'Limite de usuarios do plano atingido.', 409);
    const duplicate = await query(
      `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = $1 AND u.email = $2 AND m.status != 'REMOVED'`,
      [auth.tenantId, input.email.toLowerCase()],
    );
    if (duplicate[0]) throw new AppError('ALREADY_MEMBER', 'Este email ja pertence a equipe.', 409);
    const token = `invite_${randomBytes(32).toString('base64url')}`;
    const rows = await query<{ id: string; email: string; role: string; expires_at: Date }>(
      `INSERT INTO membership_invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')
       RETURNING id, email, role, expires_at`,
      [auth.tenantId, input.email.toLowerCase(), input.role, hashApiKey(token), auth.userId],
    );
    await recordAudit(req, { action: 'member.invited', entityType: 'MembershipInvitation', entityId: rows[0]!.id, newValues: input });
    res.status(201).json({ ...rows[0], token });
  } catch (error) {
    next(error);
  }
});

router.delete('/invitations/:id', async (req, res, next) => {
  try {
    const auth = (req as unknown as AuthenticatedRequest).auth;
    const rows = await query<{ id: string }>(
      `UPDATE membership_invitations SET status = 'REVOKED'
       WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING' RETURNING id`,
      [req.params.id, auth.tenantId],
    );
    if (!rows[0]) throw new AppError('INVITATION_NOT_FOUND', 'Convite nao encontrado.', 404);
    await recordAudit(req, { action: 'member.invitation_revoked', entityType: 'MembershipInvitation', entityId: rows[0].id });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/role', async (req, res, next) => {
  try {
    const input = roleUpdateSchema.parse(req.body);
    const auth = (req as unknown as AuthenticatedRequest).auth;
    const current = await query<{ id: string; role: string; user_id: string }>(
      'SELECT id, role, user_id FROM memberships WHERE id = $1 AND tenant_id = $2 AND status != $3',
      [req.params.id, auth.tenantId, 'REMOVED'],
    );
    if (!current[0]) throw new AppError('MEMBER_NOT_FOUND', 'Membro nao encontrado.', 404);
    if ((current[0].role === 'OWNER' || input.role === 'OWNER') && auth.role !== 'OWNER') throw new AppError('FORBIDDEN_ROLE', 'Somente o proprietario altera esta funcao.', 403);
    if (current[0].role === 'OWNER' && input.role !== 'OWNER') await ensureAnotherOwner(auth.tenantId, current[0].id);
    await query('UPDATE memberships SET role = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2', [current[0].id, auth.tenantId, input.role]);
    await recordAudit(req, { action: 'member.role_changed', entityType: 'Membership', entityId: current[0].id, oldValues: { role: current[0].role }, newValues: input });
    res.json({ id: current[0].id, role: input.role });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/status', async (req, res, next) => {
  try {
    const input = statusSchema.parse(req.body);
    const auth = (req as unknown as AuthenticatedRequest).auth;
    const current = await query<{ id: string; role: string; user_id: string }>(
      'SELECT id, role, user_id FROM memberships WHERE id = $1 AND tenant_id = $2 AND status != $3',
      [req.params.id, auth.tenantId, 'REMOVED'],
    );
    if (!current[0]) throw new AppError('MEMBER_NOT_FOUND', 'Membro nao encontrado.', 404);
    if (current[0].user_id === auth.userId) throw new AppError('SELF_STATUS_CHANGE', 'Voce nao pode suspender seu proprio acesso.', 409);
    if (current[0].role === 'OWNER') {
      if (auth.role !== 'OWNER') throw new AppError('FORBIDDEN_ROLE', 'Somente o proprietario altera outro proprietario.', 403);
      if (input.status === 'SUSPENDED') await ensureAnotherOwner(auth.tenantId, current[0].id);
    }
    await query('UPDATE memberships SET status = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2', [current[0].id, auth.tenantId, input.status]);
    if (input.status === 'SUSPENDED') await query('UPDATE auth_sessions SET revoked_at = now() WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL', [auth.tenantId, current[0].user_id]);
    await recordAudit(req, { action: `member.${input.status.toLowerCase()}`, entityType: 'Membership', entityId: current[0].id });
    res.json({ id: current[0].id, status: input.status });
  } catch (error) {
    next(error);
  }
});

async function ensureAnotherOwner(tenantId: string, excludingId: string): Promise<void> {
  const owners = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM memberships
     WHERE tenant_id = $1 AND id != $2 AND role = 'OWNER' AND status = 'ACTIVE'`,
    [tenantId, excludingId],
  );
  if ((owners[0]?.count ?? 0) < 1) throw new AppError('LAST_OWNER', 'A empresa deve manter ao menos um proprietario ativo.', 409);
}

export { router as teamRouter };
