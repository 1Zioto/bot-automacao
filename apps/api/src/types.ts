import type { Request } from 'express';
import type { Role } from '@autoflow/contracts';

export interface AuthContext {
  userId: string;
  tenantId: string;
  membershipId: string;
  role: Role;
  email: string;
}

export interface AuthenticatedRequest extends Request {
  auth: AuthContext;
}

export interface RequestContextRequest extends Request {
  requestId: string;
}

export interface ApiKeyContext {
  apiKeyId: string;
  tenantId: string;
  scopes: string[];
}

export interface ApiKeyRequest extends Request {
  apiAuth: ApiKeyContext;
}
