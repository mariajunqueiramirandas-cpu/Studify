// What the query engine needs to know about the schema, read once from pg_catalog and kept for the life of the
// process (the schema only changes through migrations, which run before the API starts):
//   * a table's primary key, the conflict target of an upsert without onConflict (as PostgREST does);
//   * which columns are json/jsonb, so contains() sends JSON there and an array literal elsewhere;
//   * a function's return shape and argument types, so rpc() answers like PostgREST (a value, an object or an
//     array) and json/jsonb arguments are sent as JSON.
import { DbQueryError } from './errors.ts';

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export interface TableInfo {
  columns: Map<string, { type: string; json: boolean }>;
  primaryKey: string[];
}

export type ReturnShape = 'void' | 'scalar' | 'scalar_set' | 'row' | 'row_set';

export interface FunctionInfo {
  shape: ReturnShape;
  /** Input argument name -> its type, as regtype text (e.g. uuid, jsonb, text[]). */
  args: Map<string, string>;
}

const JSON_TYPES = new Set(['json', 'jsonb']);

export class Catalog {
  readonly #tables = new Map<string, Promise<TableInfo>>();
  readonly #functions = new Map<string, Promise<FunctionInfo>>();

  constructor(private readonly sql: Queryable) {}

  table(schema: string, name: string): Promise<TableInfo> {
    const key = `${schema}.${name}`;
    let hit = this.#tables.get(key);
    if (!hit) {
      hit = this.#loadTable(schema, name);
      this.#tables.set(key, hit);
      hit.catch(() => this.#tables.delete(key));
    }
    return hit;
  }

  function(schema: string, name: string): Promise<FunctionInfo> {
    const key = `${schema}.${name}`;
    let hit = this.#functions.get(key);
    if (!hit) {
      hit = this.#loadFunction(schema, name);
      this.#functions.set(key, hit);
      hit.catch(() => this.#functions.delete(key));
    }
    return hit;
  }

  async #loadTable(schema: string, name: string): Promise<TableInfo> {
    const cols = await this.sql.query(
      `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, t.typname as base
         from pg_catalog.pg_attribute a
         join pg_catalog.pg_class c on c.oid = a.attrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         join pg_catalog.pg_type t on t.oid = a.atttypid
        where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
        order by a.attnum`,
      [schema, name],
    );
    if (cols.rows.length === 0) {
      throw new DbQueryError(`relation "${schema}.${name}" does not exist`, '42P01');
    }
    const pk = await this.sql.query(
      `select a.attname as name
         from pg_catalog.pg_index i
         join pg_catalog.pg_class c on c.oid = i.indrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where n.nspname = $1 and c.relname = $2 and i.indisprimary
        order by array_position(i.indkey::int2[], a.attnum)`,
      [schema, name],
    );
    return {
      columns: new Map(cols.rows.map((r: { name: string; type: string; base: string }) => [r.name, { type: r.type, json: JSON_TYPES.has(r.base) }])),
      primaryKey: pk.rows.map((r: { name: string }) => r.name),
    };
  }

  async #loadFunction(schema: string, name: string): Promise<FunctionInfo> {
    const res = await this.sql.query(
      `select p.proretset as retset, p.prorettype::regtype::text as rettype, t.typtype as typtype,
              coalesce(p.proargnames, '{}') as argnames,
              coalesce(p.proargmodes::text[], '{}') as argmodes,
              coalesce(array(select format_type(x, null) from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) x), '{}') as argtypes
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         join pg_catalog.pg_type t on t.oid = p.prorettype
        where n.nspname = $1 and p.proname = $2 and p.prokind = 'f'`,
      [schema, name],
    );
    if (res.rows.length === 0) {
      throw new DbQueryError(`Could not find the function ${schema}.${name} in the schema cache`, 'PGRST202');
    }
    if (res.rows.length > 1) {
      throw new DbQueryError(`Could not choose the best candidate function between overloads of ${schema}.${name}`, 'PGRST203');
    }
    const row = res.rows[0] as { retset: boolean; rettype: string; typtype: string; argnames: string[]; argmodes: string[]; argtypes: string[] };
    const args = new Map<string, string>();
    row.argnames.forEach((arg, i) => {
      const mode = row.argmodes[i] ?? 'i';
      if (arg && (mode === 'i' || mode === 'b' || mode === 'v')) args.set(arg, row.argtypes[i] ?? 'unknown');
    });
    // A function with OUT parameters returns `record`; so does `returns table (...)`. Both are rows.
    const isRow = row.typtype === 'c' || row.rettype === 'record';
    const shape: ReturnShape =
      row.rettype === 'void' ? 'void' : isRow ? (row.retset ? 'row_set' : 'row') : row.retset ? 'scalar_set' : 'scalar';
    return { shape, args };
  }
}
