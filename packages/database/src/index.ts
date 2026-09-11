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
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    // Tratamento de erro em clientes ociosos:
    // Evita uncaughtException quando o servidor Neon/PostgreSQL encerra conexões ociosas.
    // O pool descarta o cliente encerrado e cria um novo sob demanda.
    pool.on('error', (err) => {
      // Ignora erro de término inesperado em conexões ociosas para que não derrube o processo
      if (process.env.LOG_LEVEL === 'debug') {
        console.warn('[database] Conexão ociosa encerrada no pool:', err.message);
      }
    });
  }
  return pool;
}

function isTransientConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const msg = 'message' in error && typeof (error as any).message === 'string' ? (error as any).message : '';
  const code = 'code' in error ? (error as any).code : undefined;
  return (
    msg.includes('Connection terminated') ||
    msg.includes('connection closed') ||
    msg.includes('terminating connection') ||
    msg.includes('timeout expired') ||
    code === 'ECONNRESET' ||
    code === '57P01' || // admin_shutdown
    code === '57P02' || // crash_shutdown
    code === '57P03'    // cannot_connect_now
  );
}

export async function connect(maxAttempts = 2): Promise<PoolClient> {
  const currentPool = getPool();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let client: PoolClient | undefined;
    try {
      client = await currentPool.connect();
      const schema = getEnvironment().DATABASE_SCHEMA;
      await client.query('SELECT set_config($1, $2, false)', ['search_path', `${schema},public`]);
      return client;
    } catch (error) {
      if (client) {
        try {
          client.release(true);
        } catch {
          // Ignora se o socket já estava fechado
        }
      }
      if (attempt < maxAttempts && isTransientConnectionError(error)) {
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
        continue;
      }
      throw error;
    }
  }
  throw new Error('Não foi possível conectar ao banco de dados');
}

export async function query<T extends QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<T[]> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let client: PoolClient | undefined;
    let hasError = false;
    try {
      client = await connect();
      const result = await client.query<T>(text, [...values]);
      return result.rows;
    } catch (error) {
      hasError = true;
      if (attempt === 1 && isTransientConnectionError(error)) {
        if (client) {
          try {
            client.release(true);
          } catch {}
          client = undefined;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      throw error;
    } finally {
      if (client) {
        client.release(hasError);
      }
    }
  }
  throw new Error('Falha ao executar consulta no banco de dados');
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await connect();
  let hasError = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    hasError = true;
    try {
      await client.query('ROLLBACK');
    } catch {
      // Falha esperada se a conexão tiver sido encerrada durante o trabalho
    }
    throw error;
  } finally {
    client.release(hasError);
  }
}

export async function closePool(): Promise<void> {
  if (pool) await pool.end();
  pool = undefined;
}
