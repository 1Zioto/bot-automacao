import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getEnvironment } from '@autoflow/config';

export interface EncryptedValue {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

function encryptionKey(): Buffer {
  const configured = getEnvironment().ENCRYPTION_KEY;
  const decoded = Buffer.from(configured, 'base64');
  if (decoded.length === 32) return decoded;
  return createHash('sha256').update(configured).digest();
}

export function encryptText(value: string): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function decryptText(value: EncryptedValue): string {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), value.iv);
  decipher.setAuthTag(value.tag);
  return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString('utf8');
}

export function createApiKey(): { plainText: string; prefix: string; hash: string } {
  const prefix = randomBytes(5).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const plainText = `wa_live_${prefix}_${secret}`;
  return { plainText, prefix: `wa_live_${prefix}`, hash: hashApiKey(plainText) };
}

export function hashApiKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function apiKeyMatches(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashApiKey(value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function signWebhook(payload: string, timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

export function createWebhookSecret(): string {
  return randomBytes(32).toString('base64url');
}
