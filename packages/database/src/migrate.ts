import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, connect, getPool, query } from './index.js';
import { getEnvironment } from '@autoflow/config';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = join(currentDirectory, '..', 'migrations');

async function migrate(): Promise<void> {
  const pool = getPool();
  const schema = getEnvironment().DATABASE_SCHEMA;
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();
  for (const name of files) {
    const sql = await readFile(join(migrationsDirectory, name), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name = $1', [name]);
    if (existing[0]) {
      if (existing[0].checksum !== checksum) throw new Error(`Migration alterada depois de aplicada: ${name}`);
      continue;
    }

    const client = await connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
      await client.query('COMMIT');
      console.log(`Aplicada: ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

migrate()
  .then(() => console.log('Migrations concluidas.'))
  .finally(closePool)
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
