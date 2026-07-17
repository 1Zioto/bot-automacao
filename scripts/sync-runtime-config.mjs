import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const localRuntimePath = resolve(root, '.env.motor.local');
const legacyEnvironmentPath = resolve(root, 'bot', '.env');
const importedEnvironmentPath = process.env.RUNTIME_IMPORT_ENV
  ? resolve(root, process.env.RUNTIME_IMPORT_ENV)
  : undefined;

function parseEnvironment(contents) {
  const result = new Map();
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u);
    if (!match) continue;
    const value = match[2].replace(/^(?:"(.*)"|'(.*)')$/u, '$1$2');
    result.set(match[1], value);
  }
  return result;
}

async function readEnvironment(path) {
  try {
    return parseEnvironment(await readFile(path, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return new Map();
    throw error;
  }
}

function randomSecret(bytes) {
  return randomBytes(bytes).toString('base64');
}

function updateVercel(name, value, environment) {
  const executable = process.platform === 'win32' ? 'vercel.cmd' : 'vercel';
  const result = spawnSync(executable, ['env', 'update', name, environment, '--sensitive', '--yes'], {
    cwd: root,
    input: `${value}\n`,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`Falha ao atualizar ${name} em ${environment}: ${result.stderr.trim()}`);
  }
}

const existing = await readEnvironment(localRuntimePath);
const legacy = await readEnvironment(legacyEnvironmentPath);
const imported = importedEnvironmentPath ? await readEnvironment(importedEnvironmentPath) : new Map();
const databaseUrl = existing.get('DATABASE_URL') || legacy.get('DATABASE_URL');
if (!databaseUrl?.startsWith('postgres')) throw new Error('DATABASE_URL da Neon nao encontrada.');

const accessTokenSecret = existing.get('ACCESS_TOKEN_SECRET') || randomSecret(48);
const refreshTokenSecret = existing.get('REFRESH_TOKEN_SECRET') || randomSecret(48);
const encryptionKey = existing.get('ENCRYPTION_KEY') || randomSecret(32);
const redisUrl = imported.get('REDIS_URL') || existing.get('REDIS_URL') || '';

for (const environment of ['production', 'preview']) {
  updateVercel('ACCESS_TOKEN_SECRET', accessTokenSecret, environment);
  updateVercel('REFRESH_TOKEN_SECRET', refreshTokenSecret, environment);
  updateVercel('ENCRYPTION_KEY', encryptionKey, environment);
}

const lines = [
  'NODE_ENV=production',
  `DATABASE_URL=${databaseUrl}`,
  'DATABASE_SCHEMA=saas',
  'DATABASE_POOL_MAX=5',
  `REDIS_URL=${redisUrl}`,
  `ACCESS_TOKEN_SECRET=${accessTokenSecret}`,
  `REFRESH_TOKEN_SECRET=${refreshTokenSecret}`,
  `ENCRYPTION_KEY=${encryptionKey}`,
  'PUBLIC_APP_URL=https://vercel-panel-delta.vercel.app',
  'CORS_ORIGINS=https://vercel-panel-delta.vercel.app',
  'WHATSAPP_SESSION_PATH=.data/whatsapp-sessions',
  'WHATSAPP_HEADLESS=true',
  'LOG_LEVEL=info',
  '',
];
await writeFile(localRuntimePath, lines.join('\n'), { encoding: 'utf8', flag: 'w' });
console.log(`Configuracao sincronizada. Redis: ${redisUrl ? 'configurado' : 'pendente'}.`);
