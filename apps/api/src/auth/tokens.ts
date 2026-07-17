import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { getEnvironment } from '@autoflow/config';
import { roleSchema, type Role } from '@autoflow/contracts';
import { AppError } from '@autoflow/shared';

export interface AccessTokenClaims {
  userId: string;
  tenantId: string;
  membershipId: string;
  role: Role;
  email: string;
}

const encoder = new TextEncoder();

export async function createAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({
    tenantId: claims.tenantId,
    membershipId: claims.membershipId,
    role: claims.role,
    email: claims.email,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.userId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(encoder.encode(getEnvironment().ACCESS_TOKEN_SECRET));
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(getEnvironment().ACCESS_TOKEN_SECRET), {
      algorithms: ['HS256'],
    });
    if (!payload.sub || typeof payload.tenantId !== 'string' || typeof payload.membershipId !== 'string' || typeof payload.email !== 'string') {
      throw new Error('Claims ausentes.');
    }
    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      membershipId: payload.membershipId,
      role: roleSchema.parse(payload.role),
      email: payload.email,
    };
  } catch {
    throw new AppError('INVALID_ACCESS_TOKEN', 'Token de acesso invalido ou expirado.', 401);
  }
}

export function createRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHmac('sha256', getEnvironment().REFRESH_TOKEN_SECRET).update(token).digest('hex');
}
