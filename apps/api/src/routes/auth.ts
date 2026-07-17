import { createHash, randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import argon2 from 'argon2';
import { loginSchema, registerTenantSchema, roleSchema } from '@autoflow/contracts';
import { getPool, query, transaction } from '@autoflow/database';
import { AppError } from '@autoflow/shared';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../types.js';
import { authenticate } from '../auth/middleware.js';
import { createAccessToken, createRefreshToken, hashRefreshToken } from '../auth/tokens.js';

const router: Router = Router();
const refreshSchema = z.object({ refreshToken: z.string().min(20) });
const loginWithTenantSchema = loginSchema.extend({ tenantSlug: z.string().optional() });

function slugify(value: string): string {
  const base = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${base || 'empresa'}-${randomUUID().slice(0, 8)}`;
}

interface SessionIdentity {
  userId: string;
  tenantId: string;
  membershipId: string;
  role: string;
  email: string;
}

async function issueSession(identity: SessionIdentity, req: Request): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const role = roleSchema.parse(identity.role);
  const refreshToken = createRefreshToken();
  await query(
    `INSERT INTO auth_sessions (user_id, tenant_id, refresh_token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '30 days')`,
    [identity.userId, identity.tenantId, hashRefreshToken(refreshToken), req.headers['user-agent'] ?? null, req.ip],
  );
  return {
    accessToken: await createAccessToken({ ...identity, role }),
    refreshToken,
    expiresIn: 900,
  };
}

router.post('/register', async (req, res, next) => {
  try {
    const input = registerTenantSchema.parse(req.body);
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const identity = await transaction<SessionIdentity>(async (client) => {
      const existing = await client.query('SELECT id FROM users WHERE email = $1', [input.email.toLowerCase()]);
      if (existing.rows[0]) throw new AppError('EMAIL_IN_USE', 'Email ja cadastrado.', 409);

      const user = await client.query<{ id: string; email: string }>(
        `INSERT INTO users (name, email, password_hash, status)
         VALUES ($1, $2, $3, 'ACTIVE') RETURNING id, email`,
        [input.ownerName, input.email.toLowerCase(), passwordHash],
      );
      const tenant = await client.query<{ id: string }>(
        `INSERT INTO tenants (name, slug, document, timezone, status)
         VALUES ($1, $2, $3, $4, 'TRIAL') RETURNING id`,
        [input.companyName, slugify(input.companyName), input.document ?? null, input.timezone],
      );
      const userId = user.rows[0]!.id;
      const tenantId = tenant.rows[0]!.id;
      const membership = await client.query<{ id: string; role: string }>(
        `INSERT INTO memberships (tenant_id, user_id, role, status, accepted_at)
         VALUES ($1, $2, 'OWNER', 'ACTIVE', now()) RETURNING id, role`,
        [tenantId, userId],
      );
      const plan = await client.query<{ id: string }>("SELECT id FROM plans WHERE code = 'ESSENTIAL' AND is_active = true");
      if (!plan.rows[0]) throw new AppError('PLAN_NOT_CONFIGURED', 'Plano Essencial nao configurado.', 500);
      await client.query(
        `INSERT INTO subscriptions (tenant_id, plan_id, status, billing_cycle, trial_ends_at)
         VALUES ($1, $2, 'TRIALING', 'MONTHLY', now() + interval '14 days')`,
        [tenantId, plan.rows[0].id],
      );
      const terms = await client.query('SELECT version FROM terms_versions WHERE version = $1 AND is_active = true', [input.acceptedTermsVersion]);
      if (!terms.rows[0]) throw new AppError('TERMS_NOT_FOUND', 'Versao dos termos nao encontrada.', 400);
      await client.query(
        `INSERT INTO terms_acceptances (tenant_id, user_id, terms_version, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, userId, input.acceptedTermsVersion, req.ip, req.headers['user-agent'] ?? null],
      );
      return {
        userId,
        tenantId,
        membershipId: membership.rows[0]!.id,
        role: membership.rows[0]!.role,
        email: user.rows[0]!.email,
      };
    });

    const session = await issueSession(identity, req);
    res.status(201).json({ ...session, user: { id: identity.userId, email: identity.email }, tenant: { id: identity.tenantId } });
  } catch (error) {
    next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const input = loginWithTenantSchema.parse(req.body);
    const rows = await query<SessionIdentity & { password_hash: string }>(
      `SELECT u.id AS "userId", u.email, u.password_hash, t.id AS "tenantId",
              m.id AS "membershipId", m.role
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.status = 'ACTIVE'
       JOIN tenants t ON t.id = m.tenant_id AND t.status IN ('TRIAL', 'ACTIVE')
       WHERE u.email = $1 AND u.status = 'ACTIVE'
         AND ($2::text IS NULL OR t.slug = $2)
       ORDER BY m.created_at
       LIMIT 2`,
      [input.email.toLowerCase(), input.tenantSlug ?? null],
    );
    if (!rows[0] || !(await argon2.verify(rows[0].password_hash, input.password))) {
      throw new AppError('INVALID_CREDENTIALS', 'Email ou senha incorretos.', 401);
    }
    if (!input.tenantSlug && rows.length > 1) {
      throw new AppError('TENANT_REQUIRED', 'Informe a empresa para entrar.', 409);
    }
    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [rows[0].userId]);
    const session = await issueSession(rows[0], req);
    res.json({ ...session, user: { id: rows[0].userId, email: rows[0].email }, tenant: { id: rows[0].tenantId } });
  } catch (error) {
    next(error);
  }
});

router.post('/refresh', async (req, res, next) => {
  const client = await getPool().connect();
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    await client.query('BEGIN');
    const current = await client.query<SessionIdentity & { session_id: string }>(
      `SELECT s.id AS session_id, s.user_id AS "userId", s.tenant_id AS "tenantId",
              m.id AS "membershipId", m.role, u.email
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id AND u.status = 'ACTIVE'
       JOIN memberships m ON m.user_id = s.user_id AND m.tenant_id = s.tenant_id AND m.status = 'ACTIVE'
       JOIN tenants t ON t.id = s.tenant_id AND t.status IN ('TRIAL', 'ACTIVE')
       WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
       FOR UPDATE`,
      [hashRefreshToken(refreshToken)],
    );
    if (!current.rows[0]) throw new AppError('INVALID_REFRESH_TOKEN', 'Sessao expirada ou revogada.', 401);
    const identity = current.rows[0];
    const nextRefreshToken = createRefreshToken();
    const nextSessionId = randomUUID();
    await client.query(
      `INSERT INTO auth_sessions
         (id, user_id, tenant_id, refresh_token_hash, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '30 days')`,
      [nextSessionId, identity.userId, identity.tenantId, hashRefreshToken(nextRefreshToken), req.headers['user-agent'] ?? null, req.ip],
    );
    await client.query(
      'UPDATE auth_sessions SET revoked_at = now(), replaced_by = $2, last_used_at = now() WHERE id = $1',
      [identity.session_id, nextSessionId],
    );
    await client.query('COMMIT');
    res.json({
      accessToken: await createAccessToken({ ...identity, role: roleSchema.parse(identity.role) }),
      refreshToken: nextRefreshToken,
      expiresIn: 900,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    await query('UPDATE auth_sessions SET revoked_at = now() WHERE refresh_token_hash = $1 AND revoked_at IS NULL', [hashRefreshToken(refreshToken)]);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.get('/me', authenticate, async (req, res) => {
  const auth = (req as AuthenticatedRequest).auth;
  const fingerprint = createHash('sha256').update(`${auth.userId}:${auth.tenantId}`).digest('hex').slice(0, 12);
  res.json({ ...auth, sessionFingerprint: fingerprint });
});

export { router as authRouter };
