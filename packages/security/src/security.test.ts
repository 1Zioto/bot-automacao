import { beforeEach, describe, expect, it } from 'vitest';
import { resetEnvironmentForTests } from '@autoflow/config';
import { apiKeyMatches, createApiKey, decryptText, encryptText, signWebhook } from './index.js';

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://localhost/test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.ACCESS_TOKEN_SECRET = 'a'.repeat(32);
  process.env.REFRESH_TOKEN_SECRET = 'b'.repeat(32);
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.PUBLIC_APP_URL = 'http://localhost:3000';
  resetEnvironmentForTests();
});

describe('security', () => {
  it('protege e recupera texto com AES-GCM', () => {
    const encrypted = encryptText('mensagem sensivel');
    expect(encrypted.ciphertext.toString('utf8')).not.toContain('mensagem');
    expect(decryptText(encrypted)).toBe('mensagem sensivel');
  });

  it('armazena somente o hash de uma chave de API', () => {
    const key = createApiKey();
    expect(key.hash).not.toContain(key.plainText);
    expect(apiKeyMatches(key.plainText, key.hash)).toBe(true);
  });

  it('assina webhooks de forma deterministica', () => {
    expect(signWebhook('{"ok":true}', '123', 'secret')).toBe(signWebhook('{"ok":true}', '123', 'secret'));
  });
});
