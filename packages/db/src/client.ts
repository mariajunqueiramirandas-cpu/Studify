// The database client the API and the server operations share (ADR 0012). `createDb` gives the service client:
// it connects as the database owner, so row level security does not apply, the same trust the Supabase service
// role had. `db.asUser(claims)` gives a client that runs every statement as `authenticated` with the student's
// claims, so the same policies that guarded the app's direct queries still decide what each data endpoint sees.
//
// `auth` (Supabase Auth, still hosted) and `storage` (files on the API's disk) are attached by the API; a client
// built without them throws when either is used.
import type pg from 'pg';
import { Catalog } from './catalog.ts';
import { DbQueryError } from './errors.ts';
import { QueryBuilder, RpcBuilder, type Executor, type QueryContext, type QueryOutput, type Row } from './query.ts';
import type { DbAuth } from './auth.ts';
import type { DbStorage } from './storage-types.ts';

/** The claims of a verified access token. `sub` is the user id; `role` is `authenticated`. */
export interface Claims {
  sub: string;
  role?: string;
  email?: string | null;
  [claim: string]: unknown;
}

export interface Db {
  from(table: string): QueryBuilder;
  rpc<T = any>(fn: string, args?: Row): RpcBuilder<T>;
  /** The same client on another schema: `db.schema('private').from('idempotency_keys')`. */
  schema(name: string): Db;
  /** A SELECT written in SQL, answered as JSON rows (the same value types the builder returns). */
  select<T = any>(text: string, values?: unknown[]): Promise<T[]>;
  /** Runs `fn` with a client bound to one transaction, with this client's role and claims. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  /** A client acting as the student: every statement runs as `authenticated` with these claims. */
  asUser(claims: Claims): Db;
  auth: DbAuth;
  storage: DbStorage;
}

export interface CreateDbOptions {
  pool: pg.Pool;
  schema?: string;
  auth?: DbAuth;
  storage?: DbStorage;
  /** Cap for a student's read without its own limit (PostgREST's max_rows). Default 1000. */
  userMaxRows?: number;
  /** A student's statement is cancelled after this long. Default 15 s. */
  userStatementTimeout?: string;
}

interface Mode {
  claims: Claims | null;
}

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function missing(what: string): never {
  throw new DbQueryError(`${what} is not configured on this database client`, 'PGRST000');
}

function lazyMissing<T extends object>(what: string): T {
  return new Proxy({} as T, { get: () => missing(what) });
}

function setupSql(client: pg.PoolClient, claims: Claims, timeout: string): string {
  const role = claims.role === 'anon' ? 'anon' : 'authenticated';
  return `select set_config('role', ${client.escapeLiteral(role)}, true),
                 set_config('request.jwt.claims', ${client.escapeLiteral(JSON.stringify({ ...claims, role }))}, true),
                 set_config('statement_timeout', ${client.escapeLiteral(timeout)}, true)`;
}

/** Statements on a connection already inside a transaction. */
function clientExecutor(client: pg.PoolClient): Executor {
  return { run: (text, values) => client.query(text, values) as Promise<QueryOutput> };
}

export function createDb(options: CreateDbOptions): Db {
  const pool = options.pool;
  const catalog = new Catalog(pool);
  const auth = options.auth ?? lazyMissing<DbAuth>('auth');
  const storage = options.storage ?? lazyMissing<DbStorage>('storage');
  const userMaxRows = options.userMaxRows ?? 1000;
  const timeout = options.userStatementTimeout ?? '15s';

  async function inTransaction<T>(mode: Mode, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('begin');
      if (mode.claims) await client.query(setupSql(client, mode.claims, timeout));
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback').catch(() => {
        broken = true;
      });
      throw err;
    } finally {
      client.release(broken);
    }
  }

  function executorFor(mode: Mode): Executor {
    if (!mode.claims) return { run: (text, values) => pool.query(text, values) as Promise<QueryOutput> };
    return { run: (text, values) => inTransaction(mode, (client) => client.query(text, values) as Promise<QueryOutput>) };
  }

  function build(schema: string, mode: Mode, exec: Executor, bound: boolean): Db {
    if (!IDENT.test(schema)) throw new DbQueryError(`invalid schema: ${schema}`, '42602');
    const ctx: QueryContext = { exec, catalog, schema, maxRows: mode.claims ? userMaxRows : null };
    const db: Db = {
      from: (table) => new QueryBuilder(ctx, table),
      rpc: (fn, args = {}) => new RpcBuilder(ctx, fn, args),
      schema: (name) => build(name, mode, exec, bound),
      async select(text, values = []) {
        const res = await exec.run(`select coalesce(json_agg(_q), '[]'::json) as data from (${text}) _q`, values);
        return ((res.rows[0] as { data?: unknown[] } | undefined)?.data ?? []) as any[];
      },
      transaction(fn) {
        // Already inside one: run in it (no nested transactions).
        if (bound) return fn(db);
        return inTransaction(mode, (client) => fn(build(schema, mode, clientExecutor(client), true)));
      },
      asUser: (claims) => {
        if (!claims?.sub) throw new DbQueryError('asUser needs the claims of a verified token', 'PGRST301');
        return build(schema, { claims }, executorFor({ claims }), false);
      },
      auth,
      storage,
    };
    return db;
  }

  const service: Mode = { claims: null };
  return build(options.schema ?? 'public', service, executorFor(service), false);
}
