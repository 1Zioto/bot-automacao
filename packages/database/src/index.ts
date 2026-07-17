import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { getEnvironment } from '@autoflow/config';

let pool: Pool | undefined;

export function getPool(): Pool {
  const environment = getEnvironment();
  pool ??= new Pool({
    connectionString: environment.DATABASE_URL,
    max: 10,
    application_name: 'autoflow-saas',
    options: `-c search_path=${environment.DATABASE_SCHEMA},public`,
  });
  return pool;
}

export async function query<T extends QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<T[]> {
  const result = await getPool().query<T>(text, [...values]);
  return result.rows;
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) await pool.end();
  pool = undefined;
}
