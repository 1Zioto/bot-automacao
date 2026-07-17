import { describe, expect, it } from 'vitest';
import { roleHasPermission } from './permissions.js';

describe('RBAC', () => {
  it('permite ao proprietario gerenciar cobranca', () => {
    expect(roleHasPermission('OWNER', 'billing.manage')).toBe(true);
  });

  it('impede o operador de gerenciar usuarios', () => {
    expect(roleHasPermission('OPERATOR', 'users.manage')).toBe(false);
  });

  it('mantem o analista somente leitura', () => {
    expect(roleHasPermission('ANALYST', 'reports.read')).toBe(true);
    expect(roleHasPermission('ANALYST', 'campaigns.send')).toBe(false);
  });
});
