// Compares the enum value lists in `ENUMS` (src/core/enums.ts) with the CHECK constraints in
// supabase/migrations/*.sql. Every enum-style CHECK must be attributed to a `create table`
// statement and to a `table.column` key; every key must exist on both sides with the same values.
//
// Known, deliberate mismatches live in KNOWN_DIFFERENCES below. Each entry pins the exact
// difference, so a stale entry (the SQL or ENUMS changed) fails the test as well.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENUMS } from '../../src/core/enums.ts';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../supabase/migrations/', import.meta.url));

interface KnownDifference {
  key: string;
  /** Values present in the SQL CHECK but missing from ENUMS. */
  onlyInSql: string[];
  /** Values present in ENUMS but missing from the SQL CHECK. */
  onlyInEnums: string[];
  reason: string;
}

/**
 * Legitimate differences between the migrations and ENUMS. Empty means the two sources agree.
 * Each entry must describe the exact diff; the test fails if the diff changes or disappears.
 */
const KNOWN_DIFFERENCES: KnownDifference[] = [];

/** Strips `-- line` and `/* block *\/` comments, leaving quoted string literals untouched. */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      const end = findStringEnd(sql, i);
      out += sql.slice(i, end + 1);
      i = end + 1;
    } else if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? sql.length : close + 2;
      out += ' ';
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Index of the closing quote of the string literal that opens at `start` (handles '' escapes). */
function findStringEnd(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === "'") {
      if (sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i;
    }
    i += 1;
  }
  throw new Error(`unterminated string literal at offset ${start}`);
}

/** Index of the parenthesis that closes the one opened at `open` (skips string literals). */
function findMatchingParen(sql: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      i = findStringEnd(sql, i) + 1;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  throw new Error(`unbalanced parenthesis at offset ${open}`);
}

interface TableBody {
  table: string;
  start: number;
  end: number;
}

/** Every `create table [schema.]name ( ... )` body in the (comment-free) SQL text. */
export function findTableBodies(sql: string): TableBody[] {
  const bodies: TableBody[] = [];
  const re = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:\w+\.)?(\w+)\s*\(/gi;
  for (const match of sql.matchAll(re)) {
    const table = match[1]!;
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = findMatchingParen(sql, open);
    bodies.push({ table, start: open, end: close });
  }
  return bodies;
}

interface SqlEnumCheck {
  key: string;
  values: string[];
  /** Offset of the CHECK keyword, used to attribute it to a table body. */
  offset: number;
}

const CHECK_IN = /\bcheck\s*\(\s*(\w+)\s+in\s*\(([^()]*)\)\s*\)/gi;
const CHECK_ANY = /\bcheck\s*\(\s*(\w+)\s*=\s*any\s*\(\s*array\s*\[([^\][]*)\]\s*\)\s*\)/gi;

function quotedValues(list: string): string[] {
  return [...list.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
}

/** Enum-style CHECK constraints of the whole migration set, before table attribution. */
export function findEnumChecks(sql: string): Array<Omit<SqlEnumCheck, 'key'> & { column: string }> {
  const found: Array<Omit<SqlEnumCheck, 'key'> & { column: string }> = [];
  for (const re of [CHECK_IN, CHECK_ANY]) {
    for (const m of sql.matchAll(re)) {
      found.push({ column: m[1]!, values: quotedValues(m[2]!), offset: m.index ?? 0 });
    }
  }
  return found.sort((a, b) => a.offset - b.offset);
}

export interface ParsedSchema {
  /** `table.column` -> values, from the migrations. */
  enums: Map<string, string[]>;
  /** Enum-style CHECKs that are not inside any `create table` body, or conflict with another. */
  problems: string[];
  /** Number of enum-style CHECK constraints found. */
  checkCount: number;
}

/** Reads every migration in apply order and extracts the enum-style CHECK constraints. */
export function parseMigrations(dir: string): ParsedSchema {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const enums = new Map<string, string[]>();
  const problems: string[] = [];
  let checkCount = 0;

  for (const file of files) {
    const sql = stripSqlComments(readFileSync(`${dir}/${file}`, 'utf8'));
    const bodies = findTableBodies(sql);
    for (const check of findEnumChecks(sql)) {
      checkCount += 1;
      const body = bodies.find((b) => check.offset > b.start && check.offset < b.end);
      if (!body) {
        problems.push(`${file}: check on "${check.column}" is outside any create table (values ${check.values.join(',')})`);
        continue;
      }
      const key = `${body.table}.${check.column}`;
      const previous = enums.get(key);
      if (previous) {
        problems.push(`${file}: ${key} has more than one enum CHECK`);
        continue;
      }
      enums.set(key, check.values);
    }
  }
  return { enums, problems, checkCount };
}

function setDiff(a: readonly string[], b: readonly string[]): string[] {
  const bSet = new Set(b);
  return a.filter((v) => !bSet.has(v));
}

export interface Mismatch {
  key: string;
  onlyInSql: string[];
  onlyInEnums: string[];
  /** Same values, different order. Reported, not failed. */
  orderOnly: boolean;
  note?: string;
}

/** Compares the migration-derived map with ENUMS, both directions. */
export function compareWithEnums(
  sqlEnums: Map<string, string[]>,
  registry: Readonly<Record<string, readonly string[]>>,
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const keys = new Set([...sqlEnums.keys(), ...Object.keys(registry)]);
  for (const key of [...keys].sort()) {
    const sql = sqlEnums.get(key);
    const reg = registry[key];
    if (!sql) {
      mismatches.push({ key, onlyInSql: [], onlyInEnums: [...reg!], orderOnly: false, note: 'no CHECK in migrations' });
      continue;
    }
    if (!reg) {
      mismatches.push({ key, onlyInSql: [...sql], onlyInEnums: [], orderOnly: false, note: 'missing from ENUMS' });
      continue;
    }
    const onlyInSql = setDiff(sql, reg);
    const onlyInEnums = setDiff(reg, sql);
    if (onlyInSql.length || onlyInEnums.length) {
      mismatches.push({ key, onlyInSql, onlyInEnums, orderOnly: false });
    } else if (sql.join('|') !== reg.join('|')) {
      mismatches.push({ key, onlyInSql: [], onlyInEnums: [], orderOnly: true });
    }
  }
  return mismatches;
}

function describeMismatch(m: Mismatch): string {
  const parts: string[] = [];
  if (m.note) parts.push(m.note);
  if (m.onlyInSql.length) parts.push(`only in SQL: [${m.onlyInSql.join(', ')}]`);
  if (m.onlyInEnums.length) parts.push(`only in ENUMS: [${m.onlyInEnums.join(', ')}]`);
  if (m.orderOnly) parts.push('same values, different order');
  return `${m.key}: ${parts.join('; ')}`;
}

const parsed = parseMigrations(MIGRATIONS_DIR);
const mismatches = compareWithEnums(parsed.enums, ENUMS);
const orderOnly = mismatches.filter((m) => m.orderOnly);
const valueMismatches = mismatches.filter((m) => !m.orderOnly);

describe('ENUMS vs supabase/migrations CHECK constraints', () => {
  it('parses a realistic number of enum CHECKs from the migrations', () => {
    expect(parsed.checkCount).toBeGreaterThan(150);
    expect(parsed.enums.get('documents.status')).toEqual(['uploaded', 'processing', 'ready', 'failed', 'waiting_budget']);
    expect(parsed.enums.get('review_logs.reason')).toEqual(['scheduled', 'exam_boost', 'early']);
    expect(parsed.enums.get('moderation_actions.action')).toContain('appeal_rejected');
  });

  it('every enum-style CHECK is attributed to a create table statement, once per column', () => {
    expect(parsed.problems, parsed.problems.join('\n')).toEqual([]);
  });

  it('every mismatch between migrations and ENUMS is declared in KNOWN_DIFFERENCES', () => {
    const undeclared = valueMismatches.filter(
      (m) => !KNOWN_DIFFERENCES.some((k) => k.key === m.key),
    );
    const report = undeclared.map(describeMismatch).join('\n');
    expect(undeclared, `Undeclared mismatches (fix ENUMS or the migration, or declare them):\n${report}`).toEqual([]);
  });

  it('every KNOWN_DIFFERENCES entry still matches the exact difference it declares', () => {
    const stale: string[] = [];
    for (const known of KNOWN_DIFFERENCES) {
      const actual = valueMismatches.find((m) => m.key === known.key);
      if (!actual) {
        stale.push(`${known.key}: no longer differs (remove the entry)`);
        continue;
      }
      const sameSql = JSON.stringify(actual.onlyInSql) === JSON.stringify(known.onlyInSql);
      const sameEnums = JSON.stringify(actual.onlyInEnums) === JSON.stringify(known.onlyInEnums);
      if (!sameSql || !sameEnums) stale.push(`${known.key}: diff changed -> ${describeMismatch(actual)}`);
    }
    expect(stale, stale.join('\n')).toEqual([]);
  });

  it('every ENUMS key is backed by a CHECK in the migrations and vice versa (no orphans)', () => {
    const orphans = mismatches.filter((m) => m.note).map(describeMismatch);
    const declaredKeys = new Set(KNOWN_DIFFERENCES.map((k) => k.key));
    expect(orphans.filter((line) => !declaredKeys.has(line.split(':')[0]!)), orphans.join('\n')).toEqual([]);
  });

  it('reports value-order differences without failing (informational)', () => {
    if (orderOnly.length > 0) {
      console.info(`enums-sql: ${orderOnly.length} key(s) with the same values in a different order:\n${orderOnly.map(describeMismatch).join('\n')}`);
    }
    expect(orderOnly.every((m) => m.key.includes('.'))).toBe(true);
  });
});
