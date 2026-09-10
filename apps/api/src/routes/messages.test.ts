import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
// @ts-expect-error supertest has no types in this workspace
import request from 'supertest';
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@autoflow/database', () => ({ query: mocks.query, transaction: (fn: any) => fn({ query: mocks.query }) }));
vi.mock('@autoflow/security', () => ({ encryptText: () => ({ ciphertext: 'x', iv: 'y', tag: 'z' }) }));
vi.mock('../auth/api-key-middleware.js', () => ({ authenticateApiKey: () => (req: any, _res: any, next: any) => { req.apiAuth = { tenantId: 'tenant-test' }; next(); } }));
import { messagesRouter } from './messages.js';
const app = express();
app.use(express.json());
app.use('/messages', messagesRouter);
app.use((e: any, _req: any, res: any, _next: any) => res.status(e.statusCode || 422).json({ code: e.code || 'INVALID' }));
const input = { instanceId: '28a86bc2-7ed4-4001-82b5-42dd866ccbf8', phoneNumber: '5519999999999', text: 'Mensagem da viagem', idempotencyKey: 'test-message-001' };
beforeEach(() => mocks.query.mockReset());
describe('messages by phone', () => {
  it('resolves only eligible tenant contacts and inserts their id', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'contact-resolved', phone_number: input.phoneNumber }] }).mockResolvedValueOnce({ rows: [{ id: 'message-id', status: 'QUEUED' }] });
    expect((await request(app).post('/messages').send(input)).status).toBe(202);
    const [sql, params] = mocks.query.mock.calls[1]!;
    expect(params).toEqual([null, 'tenant-test', input.instanceId, input.phoneNumber]);
    expect(sql).toContain("consent_status = 'GRANTED'");
    expect(sql).toContain('ct.blocked_at IS NULL');
    expect(mocks.query.mock.calls[2]![1][2]).toBe('contact-resolved');
  });
  it('rejects missing/ineligible and ambiguous contacts without inserting', async () => {
    for (const rows of [[], [{ id: 'a' }, { id: 'b' }]]) {
      mocks.query.mockReset();
      mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows });
      expect((await request(app).post('/messages').send(input)).status).toBe(409);
      expect(mocks.query).toHaveBeenCalledTimes(2);
    }
  });
  it('preserves contactId support', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'd5079484-74c3-4889-a5c7-29f78c6094ca', phone_number: input.phoneNumber }] }).mockResolvedValueOnce({ rows: [{ id: 'msg', status: 'QUEUED' }] });
    expect((await request(app).post('/messages').send({ ...input, phoneNumber: undefined, contactId: 'd5079484-74c3-4889-a5c7-29f78c6094ca' })).status).toBe(202);
  });
  it('reuses existing idempotent result', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'old', status: 'SENT', instance_id: input.instanceId }] });
    expect((await request(app).post('/messages').send(input)).body.id).toBe('old');
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
  it('rejects both selectors or malformed numbers before database access', async () => {
    for (const value of [{...input, contactId: 'd5079484-74c3-4889-a5c7-29f78c6094ca'}, {...input, phoneNumber: '123'}]) {
      expect((await request(app).post('/messages').send(value)).status).toBe(422);
    }
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
