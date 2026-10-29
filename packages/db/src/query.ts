// The query builder behind db.from(...) and db.rpc(...): the supabase-js call shape the handlers and server
// operations were written against, run as SQL on Studify's own Postgres (ADR 0012). Results are JSON built by
// Postgres itself (json_agg / to_json, as PostgREST did), so timestamps, numerics and dates reach the code in the
// same form as before. The builder never throws: like supabase-js, it resolves `{ data, error, count, status }`.
//
// Supported: select (columns, `alias:column`, `column::type`, JSON paths; count 'exact' and head), insert, upsert
// (onConflict, ignoreDuplicates), update, delete, `.select()` after a write, the filters eq / neq / gt / gte / lt /
// lte / like / ilike / is / in / contains / containedBy / overlaps / textSearch / match / not / or / filter,
// order, limit, range, single and maybeSingle. Embedded resources (`questions!inner(...)`) are not: write a join
// with db.select() instead.
import type { Catalog } from './catalog.ts';
import { DbQueryError, statusOf, toDbError, type DbError } from './errors.ts';
import { columnExpr, compileNode, ident, parseLogic, parseOperation, splitTopLevel, type FilterNode, type FilterOp, type SqlParams } from './filters.ts';

export type Row = Record<string, unknown>;

export interface DbResult<T = any> {
  data: T;
  error: DbError | null;
  count: number | null;
  status: number;
  statusText: string;
}

export interface QueryOutput {
  rows: any[];
  rowCount: number | null;
}

/** Runs one statement, as the owner (service) or as a student (role and claims set for the transaction). */
export interface Executor {
  run(text: string, values: unknown[]): Promise<QueryOutput>;
}

export interface QueryContext {
  exec: Executor;
  catalog: Catalog;
  schema: string;
  /** Row cap for a read without its own limit (PostgREST's max_rows). Null: no cap. */
  maxRows: number | null;
}

type Count = 'exact';

type Action =
  | { kind: 'select'; columns: string; count?: Count; head: boolean }
  | { kind: 'insert'; rows: Row[]; upsert: { onConflict: string[] | null; ignoreDuplicates: boolean } | null; count?: Count }
  | { kind: 'update'; patch: Row; count?: Count }
  | { kind: 'delete'; count?: Count };

class Params implements SqlParams {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value === undefined ? null : value);
    return `$${this.values.length}`;
  }
}

/** The select list as SQL: `*`, `col`, `alias:col`, `col::type`, `alias:data->>key`. */
export function compileColumns(columns: string): string {
  const text = columns.replace(/\s+/g, '');
  if (text === '' || text === '*') return '*';
  if (text.includes('(')) {
    throw new DbQueryError(`embedded resources are not supported: ${columns}`, 'PGRST100', null, 'Write the join with db.select().');
  }
  return splitTopLevel(text)
    .map((item) => {
      if (item === '*') return '*';
      let alias: string | null = null;
      let expr = item;
      const aliased = /^([a-zA-Z_][a-zA-Z0-9_]*):(?!:)(.+)$/.exec(item);
      if (aliased) {
        alias = aliased[1] as string;
        expr = aliased[2] as string;
      }
      let cast = '';
      const casted = /^(.+?)::([a-zA-Z_][a-zA-Z0-9_]*(\[\])?)$/.exec(expr);
      if (casted) {
        expr = casted[1] as string;
        cast = `::${casted[2]}`;
      }
      const column = columnExpr(expr);
      const name = alias ?? column.name;
      return column.path || cast || alias ? `${column.sql}${cast} as ${ident(name)}` : column.sql;
    })
    .join(', ');
}

function ok<T>(data: T, count: number | null, status: number): DbResult<T> {
  return { data, error: null, count, status, statusText: status === 201 ? 'Created' : status === 204 ? 'No Content' : 'OK' };
}

function failed(err: unknown): DbResult<any> {
  const error = toDbError(err);
  return { data: null, error, count: null, status: statusOf(error), statusText: 'Error' };
}

function notOneRow(rows: number): DbError {
  return {
    message: 'JSON object requested, multiple (or no) rows returned',
    details: `The result contains ${rows} rows`,
    hint: null,
    code: 'PGRST116',
  };
}

/** R is what `data` holds: rows (any[]) until single() or maybeSingle() makes it one row. */
export class QueryBuilder<R = any[]> implements PromiseLike<DbResult<R>> {
  #action: Action = { kind: 'select', columns: '*', head: false };
  #returning: string | null = null;
  readonly #filters: FilterNode[] = [];
  readonly #order: Array<{ column: string; ascending: boolean; nullsFirst?: boolean }> = [];
  #limit: number | null = null;
  #offset: number | null = null;
  #single: 'one' | 'maybe' | null = null;
  #promise: Promise<DbResult<R>> | null = null;

  constructor(
    private readonly ctx: QueryContext,
    private readonly table: string,
  ) {}

  select(columns = '*', options: { count?: Count; head?: boolean } = {}): this {
    if (this.#action.kind === 'select') {
      this.#action = { kind: 'select', columns, count: options.count, head: options.head ?? false };
    } else {
      this.#returning = columns;
    }
    return this;
  }

  insert(values: object | readonly object[], options: { count?: Count } = {}): this {
    this.#action = { kind: 'insert', rows: (Array.isArray(values) ? values : [values]) as Row[], upsert: null, count: options.count };
    return this;
  }

  upsert(values: object | readonly object[], options: { onConflict?: string; ignoreDuplicates?: boolean; count?: Count } = {}): this {
    const onConflict = options.onConflict
      ? options.onConflict.split(',').map((c) => c.trim()).filter(Boolean)
      : null;
    this.#action = {
      kind: 'insert',
      rows: (Array.isArray(values) ? values : [values]) as Row[],
      upsert: { onConflict, ignoreDuplicates: options.ignoreDuplicates ?? false },
      count: options.count,
    };
    return this;
  }

  update(values: object, options: { count?: Count } = {}): this {
    this.#action = { kind: 'update', patch: values as Row, count: options.count };
    return this;
  }

  delete(options: { count?: Count } = {}): this {
    this.#action = { kind: 'delete', count: options.count };
    return this;
  }

  #cond(column: string, op: FilterOp, value: unknown, extra: { negate?: boolean; config?: string } = {}): this {
    this.#filters.push({ kind: 'cond', column, op, value, negate: extra.negate ?? false, config: extra.config, text: false });
    return this;
  }

  eq(column: string, value: unknown): this { return this.#cond(column, 'eq', value); }
  neq(column: string, value: unknown): this { return this.#cond(column, 'neq', value); }
  gt(column: string, value: unknown): this { return this.#cond(column, 'gt', value); }
  gte(column: string, value: unknown): this { return this.#cond(column, 'gte', value); }
  lt(column: string, value: unknown): this { return this.#cond(column, 'lt', value); }
  lte(column: string, value: unknown): this { return this.#cond(column, 'lte', value); }
  like(column: string, pattern: string): this { return this.#cond(column, 'like', pattern); }
  ilike(column: string, pattern: string): this { return this.#cond(column, 'ilike', pattern); }
  is(column: string, value: boolean | null): this { return this.#cond(column, 'is', value); }
  in(column: string, values: readonly unknown[]): this { return this.#cond(column, 'in', [...values]); }
  contains(column: string, value: unknown): this { return this.#cond(column, 'cs', value); }
  containedBy(column: string, value: unknown): this { return this.#cond(column, 'cd', value); }
  overlaps(column: string, value: unknown): this { return this.#cond(column, 'ov', value); }

  textSearch(column: string, query: string, options: { type?: 'plain' | 'phrase' | 'websearch'; config?: string } = {}): this {
    const op: FilterOp = options.type === 'plain' ? 'plfts' : options.type === 'phrase' ? 'phfts' : options.type === 'websearch' ? 'wfts' : 'fts';
    return this.#cond(column, op, query, { config: options.config });
  }

  match(query: object): this {
    for (const [column, value] of Object.entries(query)) this.#cond(column, 'eq', value);
    return this;
  }

  /** `.not('col', 'is', null)`, `.not('col', 'in', '(a,b)')`, `.not('col', 'eq', 5)`. */
  not(column: string, operator: string, value: unknown): this {
    if (typeof value === 'string' || value === null || typeof value === 'boolean') {
      const text = value === null ? 'null' : String(value);
      this.#filters.push(parseOperation(column, `${operator}.${text}`, true));
      return this;
    }
    if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'cs', 'cd', 'ov'].includes(operator)) {
      throw new DbQueryError(`unsupported not() operator: ${operator}`, 'PGRST100');
    }
    return this.#cond(column, operator as FilterOp, value, { negate: true });
  }

  /** `.filter('col', 'in', '(a,b)')`, PostgREST operator syntax. */
  filter(column: string, operator: string, value: unknown): this {
    this.#filters.push(parseOperation(column, `${operator}.${value === null ? 'null' : String(value)}`));
    return this;
  }

  /** `.or('a.eq.1,b.is.null')`. */
  or(filters: string, options: { referencedTable?: string; foreignTable?: string } = {}): this {
    if (options.referencedTable || options.foreignTable) {
      throw new DbQueryError('or() on an embedded resource is not supported', 'PGRST100');
    }
    this.#filters.push(parseLogic(filters, true));
    return this;
  }

  order(column: string, options: { ascending?: boolean; nullsFirst?: boolean; referencedTable?: string; foreignTable?: string } = {}): this {
    if (options.referencedTable || options.foreignTable) {
      throw new DbQueryError('order() on an embedded resource is not supported', 'PGRST100');
    }
    this.#order.push({ column, ascending: options.ascending ?? true, nullsFirst: options.nullsFirst });
    return this;
  }

  limit(count: number): this {
    this.#limit = Math.max(0, Math.floor(count));
    return this;
  }

  range(from: number, to: number): this {
    this.#offset = Math.max(0, Math.floor(from));
    this.#limit = Math.max(0, Math.floor(to) - Math.floor(from) + 1);
    return this;
  }

  single<U = any>(): QueryBuilder<U> {
    this.#single = 'one';
    return this as unknown as QueryBuilder<U>;
  }

  maybeSingle<U = any>(): QueryBuilder<U | null> {
    this.#single = 'maybe';
    return this as unknown as QueryBuilder<U | null>;
  }

  /** Typing only (supabase-js compatibility). */
  returns<U>(): QueryBuilder<U> {
    return this as unknown as QueryBuilder<U>;
  }

  then<R1 = DbResult<R>, R2 = never>(
    onfulfilled?: ((value: DbResult<R>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    this.#promise ??= this.#execute();
    return this.#promise.then(onfulfilled, onrejected);
  }

  async #where(params: Params): Promise<string> {
    if (this.#filters.length === 0) return '';
    const table = this.table;
    const ctx = this.ctx;
    const isJson = async (column: string): Promise<boolean> =>
      (await ctx.catalog.table(ctx.schema, table)).columns.get(column)?.json ?? false;
    const parts = await Promise.all(this.#filters.map((node) => compileNode(node, { params, isJson })));
    return ` where ${parts.join(' and ')}`;
  }

  #orderBy(): string {
    if (this.#order.length === 0) return '';
    const items = this.#order.map((o) => {
      const nulls = o.nullsFirst === undefined ? '' : o.nullsFirst ? ' nulls first' : ' nulls last';
      return `${columnExpr(o.column).sql} ${o.ascending ? 'asc' : 'desc'}${nulls}`;
    });
    return ` order by ${items.join(', ')}`;
  }

  /** The SQL text and parameters. Exposed for tests. */
  async build(): Promise<{ text: string; values: unknown[]; kind: Action['kind']; minimal: boolean }> {
    const params = new Params();
    const target = `${ident(this.ctx.schema)}.${ident(this.table)}`;
    const a = this.#action;

    if (a.kind === 'select') {
      const where = await this.#where(params);
      const count = a.count === 'exact' ? `(select count(*) from ${target}${where})` : 'null::bigint';
      if (a.head) return { text: `select null::json as data, ${count} as count`, values: params.values, kind: 'select', minimal: false };
      let limit = this.#limit;
      if (limit === null && this.ctx.maxRows !== null) limit = this.ctx.maxRows;
      else if (limit !== null && this.ctx.maxRows !== null) limit = Math.min(limit, this.ctx.maxRows);
      // single/maybeSingle fail on a second row, so two rows are enough to tell.
      if (this.#single) limit = limit === null ? 2 : Math.min(limit, 2);
      const page = `${limit !== null ? ` limit ${limit}` : ''}${this.#offset ? ` offset ${this.#offset}` : ''}`;
      const inner = `select ${compileColumns(a.columns)} from ${target}${where}${this.#orderBy()}${page}`;
      return {
        text: `select coalesce(json_agg(_t), '[]'::json) as data, ${count} as count from (${inner}) _t`,
        values: params.values,
        kind: 'select',
        minimal: false,
      };
    }

    let statement: string;
    if (a.kind === 'insert') {
      const columns = [...new Set(a.rows.flatMap((r) => Object.keys(r)))];
      if (columns.length === 0) {
        statement = `insert into ${target} default values`;
      } else {
        const list = columns.map(ident).join(', ');
        const json = params.add(JSON.stringify(a.rows));
        statement = `insert into ${target} (${list}) select ${list} from json_populate_recordset(null::${target}, ${json}::json)`;
      }
      if (a.upsert) {
        const conflict = a.upsert.onConflict ?? (await this.ctx.catalog.table(this.ctx.schema, this.table)).primaryKey;
        if (conflict.length === 0) throw new DbQueryError(`upsert on ${this.table} needs onConflict (no primary key)`, 'PGRST100');
        const target_ = `(${conflict.map(ident).join(', ')})`;
        const updates = columns.filter((c) => !conflict.includes(c));
        if (a.upsert.ignoreDuplicates) {
          statement += ` on conflict ${target_} do nothing`;
        } else {
          // With nothing else to set, a no-op update still returns the existing row, as PostgREST does.
          const sets = (updates.length > 0 ? updates : conflict).map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ');
          statement += ` on conflict ${target_} do update set ${sets}`;
        }
      }
    } else if (a.kind === 'update') {
      const columns = Object.keys(a.patch);
      if (columns.length === 0) throw new DbQueryError('update without columns', 'PGRST100');
      const json = params.add(JSON.stringify(a.patch));
      const sets =
        columns.length === 1
          ? `${ident(columns[0] as string)} = (select ${ident(columns[0] as string)} from json_populate_record(null::${target}, ${json}::json))`
          : `(${columns.map(ident).join(', ')}) = (select ${columns.map(ident).join(', ')} from json_populate_record(null::${target}, ${json}::json))`;
      statement = `update ${target} set ${sets}${await this.#where(params)}`;
    } else {
      statement = `delete from ${target}${await this.#where(params)}`;
    }

    // Without .select() the write has no RETURNING: a RETURNING clause makes Postgres apply the read policies to the
    // written row, and a student may write a row they cannot read back (PostgREST's return=minimal).
    if (this.#returning === null) return { text: statement, values: params.values, kind: a.kind, minimal: true };
    const data = `(select coalesce(json_agg(_r), '[]'::json) from (select ${compileColumns(this.#returning)} from _rows) _r)`;
    return {
      text: `with _rows as (${statement} returning *) select ${data} as data, (select count(*) from _rows) as count`,
      values: params.values,
      kind: a.kind,
      minimal: false,
    };
  }

  async #execute(): Promise<DbResult<R>> {
    type T = R;
    try {
      const a = this.#action;
      if (a.kind === 'insert' && a.rows.length === 0) {
        return ok((this.#returning !== null ? [] : null) as T, a.count ? 0 : null, 201);
      }
      const built = await this.build();
      const res = await this.ctx.exec.run(built.text, built.values);
      const wantsCount = 'count' in a && a.count === 'exact';
      if (built.minimal) return ok(null as T, wantsCount ? (res.rowCount ?? 0) : null, built.kind === 'insert' ? 201 : 204);
      const row = (res.rows[0] ?? {}) as { data: unknown; count: string | number | null };
      const count = wantsCount && row.count !== null && row.count !== undefined ? Number(row.count) : null;
      const created = built.kind === 'insert';
      if (row.data === null || row.data === undefined) {
        return ok(null as T, count, created ? 201 : built.kind === 'select' ? 200 : 204);
      }
      const rows = row.data as unknown[];
      if (this.#single) {
        if (rows.length === 1) return ok(rows[0] as T, count, created ? 201 : 200);
        if (rows.length === 0 && this.#single === 'maybe') return ok(null as T, count, 200);
        const error = notOneRow(rows.length);
        return { data: null as T, error, count: null, status: 406, statusText: 'Not Acceptable' };
      }
      return ok(rows as T, count, created ? 201 : 200);
    } catch (err) {
      return failed(err);
    }
  }
}

export class RpcBuilder<T = any> implements PromiseLike<DbResult<T>> {
  #single: 'one' | 'maybe' | null = null;
  #promise: Promise<DbResult<T>> | null = null;

  constructor(
    private readonly ctx: QueryContext,
    private readonly fn: string,
    private readonly args: Row,
  ) {}

  single(): this {
    this.#single = 'one';
    return this;
  }

  maybeSingle(): this {
    this.#single = 'maybe';
    return this;
  }

  returns<U>(): RpcBuilder<U> {
    return this as unknown as RpcBuilder<U>;
  }

  then<R1 = DbResult<T>, R2 = never>(
    onfulfilled?: ((value: DbResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    this.#promise ??= this.#execute();
    return this.#promise.then(onfulfilled, onrejected);
  }

  /** The SQL text and parameters. Exposed for tests. */
  async build(): Promise<{ text: string; values: unknown[]; shape: string }> {
    const info = await this.ctx.catalog.function(this.ctx.schema, this.fn);
    const params = new Params();
    const args = Object.entries(this.args)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => {
        const type = info.args.get(name);
        if (!type) {
          throw new DbQueryError(`Could not find the function ${this.ctx.schema}.${this.fn}(${Object.keys(this.args).join(', ')}) in the schema cache`, 'PGRST202');
        }
        const isJson = type === 'json' || type === 'jsonb';
        const bound = isJson && value !== null ? JSON.stringify(value) : value;
        return `${ident(name)} => ${params.add(bound)}::${type}`;
      });
    const call = `${ident(this.ctx.schema)}.${ident(this.fn)}(${args.join(', ')})`;
    let text: string;
    switch (info.shape) {
      case 'void':
        text = `select null::json as data from (select ${call}) _v`;
        break;
      case 'scalar':
        text = `select to_json(${call}) as data`;
        break;
      case 'scalar_set':
        text = `select coalesce(json_agg(_v), '[]'::json) as data from ${call} as _v`;
        break;
      case 'row':
        text = `select (select to_json(_r) from ${call} as _r) as data`;
        break;
      case 'row_set':
        text = `select coalesce(json_agg(_r), '[]'::json) as data from ${call} as _r`;
        break;
    }
    return { text, values: params.values, shape: info.shape };
  }

  async #execute(): Promise<DbResult<T>> {
    try {
      const built = await this.build();
      const res = await this.ctx.exec.run(built.text, built.values);
      const data = (res.rows[0] as { data?: unknown } | undefined)?.data ?? null;
      if (this.#single && Array.isArray(data)) {
        if (data.length === 1) return ok(data[0] as T, null, 200);
        if (data.length === 0 && this.#single === 'maybe') return ok(null as T, null, 200);
        return { data: null as T, error: notOneRow(data.length), count: null, status: 406, statusText: 'Not Acceptable' };
      }
      return ok(data as T, null, built.shape === 'void' ? 204 : 200);
    } catch (err) {
      return failed(err);
    }
  }
}
