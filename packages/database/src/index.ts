import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { getEnvironment } from '@autoflow/config';

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const environment = getEnvironment();
    const maxConnections = process.env.VERCEL
      ? Math.min(environment.DATABASE_POOL_MAX, 2)
      : environment.DATABASE_POOL_MAX;
    pool = new Pool({
      connectionString: environment.DATABASE_URL,
      max: maxConnections,
      application_name: 'autoflow-saas',
    });
  }
  return pool;
}

export async function connect(): Promise<PoolClient> {
  const client = await getPool().connect();
  try {
    const schema = getEnvironment().DATABASE_SCHEMA;
    await client.query('SELECT set_config($1, $2, false)', ['search_path', `${schema},public`]);
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

export async function query<T extends QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<T[]> {
  const client = await connect();
  try {
    const result = await client.query<T>(text, [...values]);
    return result.rows;
  } finally {
    client.release();
  }
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await connect();
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
