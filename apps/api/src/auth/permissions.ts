import type { Role } from '@autoflow/contracts';

export const permissions = [
  'tenant.manage',
  'billing.manage',
  'users.read',
  'users.manage',
  'instances.read',
  'instances.manage',
  'contacts.read',
  'contacts.manage',
  'campaigns.read',
  'campaigns.manage',
  'campaigns.send',
  'reports.read',
  'integrations.manage',
  'audit.read',
] as const;

export type Permission = (typeof permissions)[number];

const rolePermissions: Record<Role, ReadonlySet<Permission>> = {
  OWNER: new Set(permissions),
  ADMIN: new Set([
    'users.read',
    'users.manage',
    'instances.read',
    'instances.manage',
    'contacts.read',
    'contacts.manage',
    'campaigns.read',
    'campaigns.manage',
    'campaigns.send',
    'reports.read',
    'integrations.manage',
    'audit.read',
  ]),
  OPERATOR: new Set([
    'instances.read',
    'contacts.read',
    'contacts.manage',
    'campaigns.read',
    'campaigns.manage',
    'campaigns.send',
    'reports.read',
  ]),
  ANALYST: new Set(['instances.read', 'contacts.read', 'campaigns.read', 'reports.read']),
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return rolePermissions[role].has(permission);
}
