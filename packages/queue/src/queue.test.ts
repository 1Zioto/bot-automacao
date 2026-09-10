import { describe, expect, it } from 'vitest';
import { campaignPreparationJobSchema, contactImportJobSchema, instanceLifecycleJobSchema, outboundMessageJobSchema } from './index.js';

const uuid = '22222222-2222-4222-8222-222222222222';

describe('job contracts', () => {
  it('exige tenant em todo envio', () => {
    expect(outboundMessageJobSchema.safeParse({ instanceId: uuid, recipientId: uuid, idempotencyKey: '12345678' }).success).toBe(false);
  });

  it('valida preparacao de campanha', () => {
    expect(campaignPreparationJobSchema.parse({ tenantId: uuid, campaignId: uuid, requestedBy: uuid }).tenantId).toBe(uuid);
  });

  it('rejeita acao desconhecida de instancia', () => {
    expect(instanceLifecycleJobSchema.safeParse({ tenantId: uuid, instanceId: uuid, action: 'STEAL' }).success).toBe(false);
  });

  it('valida importacao de contatos do WhatsApp', () => {
    expect(contactImportJobSchema.parse({ tenantId: uuid, instanceId: uuid, requestedBy: uuid }).instanceId).toBe(uuid);
  });
});
