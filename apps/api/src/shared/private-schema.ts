// The `private` schema is never exposed through PostgREST (data-model §1, supabase/config.toml), so the
// API reaches it over its direct Postgres connection instead. `withPrivateSchema` routes
// `db.schema('private')` to a small query builder with the same call shape as supabase-js, so handlers and
// the test fakes stay unchanged. It covers only what the handlers use: select / eq / order / limit /
// maybeSingle / single, insert, update, delete, upsert and rpc. Errors resolve as `{ data, error }` with
// PostgREST's field names (message, details, hint, code), like supabase-js.
import type { SupabaseClient } from '@supabase/supabase-js';
import type pg from 'pg';

export interface PrivateError {
  message: string;
  details: string | null;
  hint: string | null;
  code: string;
}

export interface PrivateResult<T = unknown> {
  data: T;
  error: PrivateError | null;
}

type Row = Record<string, unknown>;
type Queryable = Pick<pg.Pool, 'query'>;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`invalid identifier: ${name}`);
  return `"${name}"`;
}

function toError(err: unknown): PrivateError {
  const e = err as { message?: string; detail?: string; hint?: string; code?: string };
  return { message: e.message ?? String(err), details: e.detail ?? null, hint: e.hint ?? null, code: e.code ?? '' };
}

/** PostgREST returns timestamps as strings; node-postgres returns Date objects. Keep the PostgREST shape. */
function normalize(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
}

type Action =
  | { kind: 'select'; columns: string }
  | { kind: 'insert'; row: Row }
  | { kind: 'update'; patch: Row }
  | { kind: 'delete' }
  | { kind: 'upsert'; row: Row; onConflict: string[]; ignoreDuplicates: boolean };

export class PrivateQuery implements PromiseLike<PrivateResult> {
  #filters: Array<{ column: string; value: unknown }> = [];
  #order: Array<{ column: string; ascending: boolean }> = [];
  #limit: number | null = null;
  #single: 'maybe' | 'one' | null = null;
  #action: Action = { kind: 'select', columns: '*' };

  constructor(
    private readonly sql: Queryable,
    private readonly table: string,
  ) {}

  select(columns = '*'): this {
    this.#action = { kind: 'select', columns };
    return this;
  }

  insert(row: Row): this {
    this.#action = { kind: 'insert', row };
    return this;
  }

  update(patch: Row): this {
    this.#action = { kind: 'update', patch };
    return this;
  }

  delete(): this {
    this.#action = { kind: 'delete' };
    return this;
  }

  upsert(row: Row, options: { onConflict?: string; ignoreDuplicates?: boolean } = {}): this {
    const onConflict = (options.onConflict ?? '').split(',').map((c) => c.trim()).filter(Boolean);
    this.#action = { kind: 'upsert', row, onConflict, ignoreDuplicates: options.ignoreDuplicates ?? false };
    return this;
  }

  eq(column: string, value: unknown): this {
    this.#filters.push({ column, value });
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}): this {
    this.#order.push({ column, ascending: options.ascending ?? true });
    return this;
  }

  limit(n: number): this {
    this.#limit = n;
    return this;
  }

  maybeSingle(): this {
    this.#single = 'maybe';
    return this;
  }

  single(): this {
    this.#single = 'one';
    return this;
  }

  /** The SQL text and parameters. Exposed for tests. */
  build(): { text: string; values: unknown[] } {
    const values: unknown[] = [];
    const param = (v: unknown): string => {
      values.push(v);
      return `$${values.length}`;
    };
    const table = `"private".${ident(this.table)}`;
    const where = (): string =>
      this.#filters.length === 0
        ? ''
        : ` where ${this.#filters.map((f) => (f.value === null ? `${ident(f.column)} is null` : `${ident(f.column)} = ${param(f.value)}`)).join(' and ')}`;
    const a = this.#action;
    switch (a.kind) {
      case 'select': {
        const cols = a.columns.trim() === '*' ? '*' : a.columns.split(',').map((c) => ident(c.trim())).join(', ');
        let text = `select ${cols} from ${table}${where()}`;
        if (this.#order.length > 0) text += ` order by ${this.#order.map((o) => `${ident(o.column)} ${o.ascending ? 'asc' : 'desc'}`).join(', ')}`;
        // maybeSingle errors on more than one row, so fetch two to tell.
        const limit = this.#single ? 2 : this.#limit;
        if (limit !== null) text += ` limit ${Math.max(0, Math.floor(limit))}`;
        return { text, values };
      }
      case 'insert':
      case 'upsert': {
        const cols = Object.keys(a.row);
        let text = `insert into ${table} (${cols.map(ident).join(', ')}) values (${cols.map((c) => param(a.row[c])).join(', ')})`;
        if (a.kind === 'upsert') {
          const target = a.onConflict.length > 0 ? ` (${a.onConflict.map(ident).join(', ')})` : '';
          const updates = cols.filter((c) => !a.onConflict.includes(c));
          text +=
            a.ignoreDuplicates || updates.length === 0
              ? ` on conflict${target} do nothing`
              : ` on conflict${target} do update set ${updates.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ')}`;
        }
        return { text, values };
      }
      case 'update': {
        const sets = Object.keys(a.patch).map((c) => `${ident(c)} = ${param(a.patch[c])}`);
        return { text: `update ${table} set ${sets.join(', ')}${where()}`, values };
      }
      case 'delete':
        return { text: `delete from ${table}${where()}`, values };
    }
  }

  async #run(): Promise<PrivateResult> {
    let built: { text: string; values: unknown[] };
    try {
      built = this.build();
    } catch (err) {
      return { data: null, error: toError(err) };
    }
    try {
      const res = await this.sql.query(built.text, built.values);
      if (this.#action.kind !== 'select') return { data: null, error: null };
      const rows = (res.rows as Row[]).map(normalize);
      if (!this.#single) return { data: rows, error: null };
      if (rows.length > 1 || (rows.length === 0 && this.#single === 'one')) {
        return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', details: null, hint: null, code: 'PGRST116' } };
      }
      return { data: rows[0] ?? null, error: null };
    } catch (err) {
      return { data: null, error: toError(err) };
    }
  }

  then<R1 = PrivateResult, R2 = never>(
    onfulfilled?: ((value: PrivateResult) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.#run().then(onfulfilled, onrejected);
  }
}

/** Calls `private.<fn>` with named arguments and resolves its scalar result. */
export async function privateRpc(sql: Queryable, fn: string, args: Row = {}): Promise<PrivateResult> {
  try {
    const names = Object.keys(args);
    const list = names.map((n, i) => `${ident(n)} => $${i + 1}`).join(', ');
    const res = await sql.query(`select "private".${ident(fn)}(${list}) as result`, names.map((n) => args[n]));
    const value = (res.rows[0] as Row | undefined)?.result ?? null;
    return { data: value instanceof Date ? value.toISOString() : value, error: null };
  } catch (err) {
    return { data: null, error: toError(err) };
  }
}

export function privateSchema(sql: Queryable) {
  return {
    from: (table: string) => new PrivateQuery(sql, table),
    rpc: (fn: string, args: Row = {}) => privateRpc(sql, fn, args),
  };
}

/** Routes `client.schema('private')` to direct SQL; every other schema keeps going through PostgREST. */
export function withPrivateSchema(client: SupabaseClient, sql: Queryable): SupabaseClient {
  const original = client.schema.bind(client);
  const routed = privateSchema(sql);
  client.schema = ((name: string) => (name === 'private' ? routed : original(name))) as typeof client.schema;
  return client;
}
