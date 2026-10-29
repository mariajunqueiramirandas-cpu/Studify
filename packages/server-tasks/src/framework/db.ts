// Direct SQL for ingestion, budgets, progress and calendar triggers.
import pg from 'pg';

/** Minimal query surface shared by Pool and PoolClient. */
export interface Sql {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export function createPool(connectionString: string, max: number): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'studify-api-tasks',
  });
  pool.on('error', () => {
    // Idle client errors (for example a failover) are recovered by the pool; jobs surface real failures.
  });
  return pool;
}

/** Runs `fn` in a transaction on one client. Rolls back on any throw. */
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Returns whether a table exists. Used for tables that other migrations add later (notes, glossary, feed). */
export async function tableExists(sql: Sql, qualifiedName: string): Promise<boolean> {
  const { rows } = await sql.query<{ exists: boolean }>(
    `select to_regclass($1) is not null as exists`,
    [qualifiedName],
  );
  return rows[0]?.exists === true;
}
