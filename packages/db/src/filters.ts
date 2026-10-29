// Filters in the shape supabase-js builds them, compiled to SQL. Most arrive as method calls (eq, in, is, ...);
// or(), not() and filter() also take PostgREST's text syntax (`a.eq.1,b.is.null,and(c.gt.2,d.lt.3)`), which is
// parsed here. Every value becomes a bind parameter; column names are checked identifiers, so no caller text ever
// reaches the SQL unquoted.
import { DbQueryError } from './errors.ts';

export type FilterOp =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'like' | 'ilike' | 'match' | 'imatch'
  | 'is' | 'isdistinct' | 'in'
  | 'cs' | 'cd' | 'ov'
  | 'fts' | 'plfts' | 'phfts' | 'wfts';

const OPS = new Set<string>(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'match', 'imatch', 'is', 'isdistinct', 'in', 'cs', 'cd', 'ov', 'fts', 'plfts', 'phfts', 'wfts']);

export interface Condition {
  kind: 'cond';
  column: string;
  op: FilterOp;
  value: unknown;
  negate: boolean;
  /** Text search configuration (fts family). */
  config?: string;
  /** The value came from PostgREST text syntax, so it is a string to be read as Postgres would. */
  text: boolean;
}

export interface Group {
  kind: 'group';
  or: boolean;
  negate: boolean;
  items: FilterNode[];
}

export type FilterNode = Condition | Group;

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function ident(name: string): string {
  if (!IDENT.test(name)) throw new DbQueryError(`invalid identifier: ${name}`, '42602');
  return `"${name}"`;
}

/** A column, or a JSON path into one (`data->a->>b`, `items->0`), as SQL. */
export function columnExpr(text: string): { sql: string; name: string; head: string; path: boolean } {
  const parts = text.split(/(->>?)/);
  const head = parts[0] ?? '';
  let sql = ident(head);
  let name = head;
  for (let i = 1; i < parts.length; i += 2) {
    const arrow = parts[i] as '->' | '->>';
    const key = parts[i + 1] ?? '';
    if (/^-?\d+$/.test(key)) sql += `${arrow}${key}`;
    else if (IDENT.test(key)) sql += `${arrow}'${key}'`;
    else throw new DbQueryError(`invalid JSON path: ${text}`, '42602');
    name = key;
  }
  return { sql, name, head, path: parts.length > 1 };
}

/** Splits on commas outside parentheses and double quotes. */
export function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (ch === '\\' && quoted && i + 1 < text.length) {
      current += ch + text[i + 1];
      i += 1;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '(') depth += 1;
    else if (!quoted && ch === ')') depth -= 1;
    if (ch === ',' && depth === 0 && !quoted) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.length > 0 || out.length > 0) out.push(current);
  return out;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return value;
}

/** A PostgREST operator with its text value (`eq.5`, `in.(a,b)`, `wfts(portuguese).dia`), as a condition. */
export function parseOperation(column: string, operation: string, negateOuter = false): Condition {
  let negate = negateOuter;
  let rest = operation;
  if (rest.startsWith('not.')) {
    negate = !negate;
    rest = rest.slice(4);
  }
  const dot = rest.indexOf('.');
  if (dot < 0) throw new DbQueryError(`invalid filter: ${column}.${operation}`, 'PGRST100');
  let opText = rest.slice(0, dot);
  const raw = rest.slice(dot + 1);
  let config: string | undefined;
  const fts = /^(fts|plfts|phfts|wfts)\(([a-zA-Z_][a-zA-Z0-9_]*)\)$/.exec(opText);
  if (fts) {
    opText = fts[1] as string;
    config = fts[2];
  }
  if (!OPS.has(opText)) throw new DbQueryError(`unknown filter operator: ${opText}`, 'PGRST100');
  return { kind: 'cond', column, op: opText as FilterOp, value: textValue(opText as FilterOp, raw), negate, config, text: true };
}

function textValue(op: FilterOp, raw: string): unknown {
  if (op === 'is') {
    const v = raw.toLowerCase();
    if (v === 'null') return null;
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'unknown') return 'unknown';
    throw new DbQueryError(`invalid value for is: ${raw}`, 'PGRST100');
  }
  if (op === 'in') {
    const inner = raw.startsWith('(') && raw.endsWith(')') ? raw.slice(1, -1) : raw;
    return inner === '' ? [] : splitTopLevel(inner).map(unquote);
  }
  return unquote(raw);
}

/** The text of or() / and(): `a.eq.1,and(b.gt.2,c.is.null),not.or(d.eq.4,e.eq.5)`. */
export function parseLogic(text: string, or: boolean, negate = false): Group {
  const items = splitTopLevel(text).map((part) => parseLogicItem(part.trim()));
  return { kind: 'group', or, negate, items };
}

function parseLogicItem(part: string): FilterNode {
  const group = /^(not\.)?(and|or)\((.*)\)$/s.exec(part);
  if (group) return parseLogic(group[3] as string, group[2] === 'or', !!group[1]);
  const dot = part.indexOf('.');
  if (dot <= 0) throw new DbQueryError(`invalid logic tree item: ${part}`, 'PGRST100');
  return parseOperation(part.slice(0, dot), part.slice(dot + 1));
}

export interface SqlParams {
  add(value: unknown): string;
}

export interface FilterContext {
  params: SqlParams;
  /** Whether a column is json/jsonb (contains/contained/overlaps send JSON there). */
  isJson(column: string): Promise<boolean>;
}

const COMPARE: Partial<Record<FilterOp, string>> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', isdistinct: 'is distinct from' };
const TSQUERY: Partial<Record<FilterOp, string>> = { fts: 'to_tsquery', plfts: 'plainto_tsquery', phfts: 'phraseto_tsquery', wfts: 'websearch_to_tsquery' };

export async function compileNode(node: FilterNode, ctx: FilterContext): Promise<string> {
  if (node.kind === 'group') {
    if (node.items.length === 0) return node.negate ? 'false' : 'true';
    const parts = await Promise.all(node.items.map((item) => compileNode(item, ctx)));
    const joined = `(${parts.join(node.or ? ' or ' : ' and ')})`;
    return node.negate ? `not ${joined}` : joined;
  }
  const sql = await compileCondition(node, ctx);
  return node.negate ? `not (${sql})` : sql;
}

async function compileCondition(c: Condition, ctx: FilterContext): Promise<string> {
  const col = columnExpr(c.column).sql;
  const p = ctx.params;
  switch (c.op) {
    case 'eq':
    case 'neq':
      // eq(null) means "is null" (the private-schema builder this replaces did the same; PostgREST would compare
      // with the text 'null').
      if (c.value === null || c.value === undefined) return `${col} ${c.op === 'eq' ? 'is' : 'is not'} null`;
      return `${col} ${COMPARE[c.op]} ${p.add(c.value)}`;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'isdistinct':
      return `${col} ${COMPARE[c.op]} ${p.add(c.value)}`;
    case 'like':
    case 'ilike':
      // PostgREST accepts * as the wildcard in URLs; supabase-js callers pass %. Both work.
      return `${col} ${c.op} ${p.add(String(c.value).replace(/\*/g, '%'))}`;
    case 'match':
      return `${col} ~ ${p.add(c.value)}`;
    case 'imatch':
      return `${col} ~* ${p.add(c.value)}`;
    case 'is':
      if (c.value === null) return `${col} is null`;
      if (c.value === true) return `${col} is true`;
      if (c.value === false) return `${col} is false`;
      if (c.value === 'unknown') return `${col} is unknown`;
      throw new DbQueryError(`invalid value for is: ${String(c.value)}`, 'PGRST100');
    case 'in': {
      const list = Array.isArray(c.value) ? c.value : [c.value];
      if (list.length === 0) return 'false';
      return `${col} = any(${p.add(list)})`;
    }
    case 'cs':
    case 'cd':
    case 'ov': {
      const op = c.op === 'cs' ? '@>' : c.op === 'cd' ? '<@' : '&&';
      if (typeof c.value === 'string') return `${col} ${op} ${p.add(c.value)}`;
      const target = columnExpr(c.column);
      if (target.path || (await ctx.isJson(target.head))) return `${col} ${op} ${p.add(JSON.stringify(c.value))}::jsonb`;
      return `${col} ${op} ${p.add(c.value)}`;
    }
    case 'fts':
    case 'plfts':
    case 'phfts':
    case 'wfts': {
      const fn = TSQUERY[c.op] as string;
      const query = c.config ? `${fn}(${p.add(c.config)}::regconfig, ${p.add(c.value)})` : `${fn}(${p.add(c.value)})`;
      return `${col} @@ ${query}`;
    }
  }
}
