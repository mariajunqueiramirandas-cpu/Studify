// Compares the enum value lists in `ENUMS` (src/core/enums.ts) with the CHECK constraints in
// supabase/migrations/*.sql. Every enum-style CHECK must be attributed to a `create table`
// statement and to a `table.column` key; every key must exist on both sides with the same values.
//
// Known mismatches live in KNOWN_DIFFERENCES below. Each entry pins the exact difference, so a
// stale entry (the SQL or ENUMS changed) fails the test as well.
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
 * Differences between the migrations and ENUMS that are not fixed yet. Each entry pins the exact
 * diff; the test fails if the diff changes or disappears. Remove an entry once ENUMS
 * (src/core/enums.ts) or the migration is aligned.
 */
const KNOWN_DIFFERENCES: KnownDifference[] = [
  {
    key: 'ai_budget_reservations.status',
    onlyInSql: ['reserved', 'released', 'settled'],
    onlyInEnums: [],
    reason: 'CHECK exists in 20260101000100_core.sql (private table) but ENUMS has no entry for it',
  },
  {
    key: 'glossary_terms.hidden_reason',
    onlyInSql: ['under_review', 'removed'],
    onlyInEnums: [],
    reason: 'CHECK exists in 20260102000000_phase1.sql; ENUMS has no entry (HIDDEN_REASON exists and fits)',
  },
  {
    key: 'push_tokens.platform',
    onlyInSql: ['android', 'ios'],
    onlyInEnums: [],
    reason: 'CHECK defaults to android in 20260101000100_core.sql; ENUMS has no entry for push_tokens.platform',
  },
  {
    key: 'topic_reads.depth',
    onlyInSql: ['tldr', 'study', 'deep', 'class_summary'],
    onlyInEnums: [],
    reason: 'CHECK in 20260102000000_phase1.sql mirrors NOTE_DEPTH; ENUMS has no entry for topic_reads.depth',
  },
  {
    key: 'tutor_messages.mode',
    onlyInSql: ['answer', 'socratic', 'quiz'],
    onlyInEnums: [],
    reason: 'CHECK in 20260102000000_phase1.sql mirrors TUTOR_MODE; ENUMS only registers tutor_threads.mode',
  },
  {
    key: 'nudge_events.kind',
    onlyInSql: [],
    onlyInEnums: ['prerequisite_detective', 'long_session', 'daily_load', 'late_night', 'performance_drop', 'overload_trend', 'checkin_low'],
    reason: 'nudge_events has no CREATE TABLE in supabase/migrations yet (data-model Phase 2 list); ENUMS is ahead of the schema',
  },
  {
    key: 'nudge_events.action',
    onlyInSql: [],
    onlyInEnums: ['acted', 'dismissed', 'accepted', 'disabled'],
    reason: 'nudge_events has no CREATE TABLE in supabase/migrations yet; ENUMS is ahead of the schema',
  },
];

/** Strips `-- line` and `/* block *\/` comments, leaving quoted string literals untouched. */
function stripSqlComments(sql: string): string {
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
function findTableBodies(sql: string): TableBody[] {
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
  column: string;
  values: string[];
  /** Offset of the CHECK keyword, used to attribute it to a table body. */
  offset: number;
}

// A list of quoted text values only: numeric CHECKs such as `feedback in (-1, 1)` are not text enums.
const QUOTED_LIST = String.raw`('(?:[^']|'')*'(?:\s*,\s*'(?:[^']|'')*')*)`;
const CHECK_IN = new RegExp(String.raw`\bcheck\s*\(\s*(\w+)\s+in\s*\(\s*${QUOTED_LIST}\s*\)\s*\)`, 'gi');
const CHECK_ANY = new RegExp(String.raw`\bcheck\s*\(\s*(\w+)\s*=\s*any\s*\(\s*array\s*\[\s*${QUOTED_LIST}\s*\]\s*\)\s*\)`, 'gi');

function quotedValues(list: string): string[] {
  return [...list.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
}

/** Enum-style CHECK constraints of the whole migration set, before table attribution. */
function findEnumChecks(sql: string): SqlEnumCheck[] {
  const found: SqlEnumCheck[] = [];
  for (const re of [CHECK_IN, CHECK_ANY]) {
    for (const m of sql.matchAll(re)) {
      found.push({ column: m[1]!, values: quotedValues(m[2]!), offset: m.index ?? 0 });
    }
  }
  return found.sort((a, b) => a.offset - b.offset);
}

interface ParsedSchema {
  /** `table.column` -> values, from the migrations. */
  enums: Map<string, string[]>;
  /** Enum-style CHECKs that are not inside any `create table` body, or conflict with another. */
  problems: string[];
  /** Number of enum-style CHECK constraints found. */
  checkCount: number;
}

const ALTER_DROP = /\balter\s+table\s+(?:only\s+)?(?:\w+\.)?(\w+)\s+drop\s+constraint\b/gi;
const ALTER_ADD = /\balter\s+table\s+(?:only\s+)?(?:\w+\.)?(\w+)\s+add\s+constraint\b/i;

/**
 * Reads every migration in apply order and extracts the enum-style CHECK constraints. A CHECK inside a
 * `create table` defines its column. A CHECK added by `alter table <t> add constraint` replaces the column's
 * CHECK only when the same migration chain dropped a constraint of that table first (`drop constraint`).
 */
function parseMigrations(dir: string): ParsedSchema {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const enums = new Map<string, string[]>();
  const problems: string[] = [];
  const droppedTables = new Set<string>();
  let checkCount = 0;

  for (const file of files) {
    const sql = stripSqlComments(readFileSync(`${dir}/${file}`, 'utf8'));
    const bodies = findTableBodies(sql);
    const drops = [...sql.matchAll(ALTER_DROP)].map((m) => ({ offset: m.index ?? 0, table: m[1]! }));
    const checks = findEnumChecks(sql).map((check) => ({ offset: check.offset, check }));
    const events = [...drops.map((d) => ({ offset: d.offset, drop: d.table, check: null as SqlEnumCheck | null })), ...checks.map((c) => ({ offset: c.offset, drop: null as string | null, check: c.check }))].sort(
      (a, b) => a.offset - b.offset,
    );

    for (const event of events) {
      if (event.drop !== null) {
        droppedTables.add(event.drop);
        continue;
      }
      const check = event.check!;
      checkCount += 1;
      const body = bodies.find((b) => check.offset > b.start && check.offset < b.end);
      if (body) {
        const key = `${body.table}.${check.column}`;
        if (enums.has(key)) {
          problems.push(`${file}: ${key} has more than one enum CHECK`);
          continue;
        }
        enums.set(key, check.values);
        continue;
      }
      // Not inside a create table: must be an `alter table <t> add constraint` statement.
      const statementStart = sql.lastIndexOf(';', check.offset) + 1;
      const alter = ALTER_ADD.exec(sql.slice(statementStart, check.offset));
      if (!alter) {
        problems.push(`${file}: check on "${check.column}" is outside any create table (values ${check.values.join(',')})`);
        continue;
      }
      const table = alter[1]!;
      const key = `${table}.${check.column}`;
      if (enums.has(key) && !droppedTables.has(table)) {
        problems.push(`${file}: ${key} has more than one enum CHECK (add a drop constraint before replacing it)`);
        continue;
      }
      enums.set(key, check.values);
      droppedTables.delete(table);
    }
  }
  return { enums, problems, checkCount };
}

function setDiff(a: readonly string[], b: readonly string[]): string[] {
  const bSet = new Set(b);
  return a.filter((v) => !bSet.has(v));
}

interface Mismatch {
  key: string;
  onlyInSql: string[];
  onlyInEnums: string[];
  /** Same values, different order. Reported, not failed. */
  orderOnly: boolean;
  note?: string;
}

/** Compares the migration-derived map with ENUMS, both directions. */
function compareWithEnums(
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
const failing = mismatches.filter((m) => !m.orderOnly);
const orderOnly = mismatches.filter((m) => m.orderOnly);

describe('ENUMS vs supabase/migrations CHECK constraints', () => {
  it('parses a realistic number of enum CHECKs from the migrations', () => {
    expect(parsed.checkCount).toBeGreaterThanOrEqual(100); // 111 text-enum CHECKs in Phase 0-2 at time of writing
    expect(parsed.enums.get('documents.status')).toEqual(['uploaded', 'processing', 'ready', 'failed', 'waiting_budget']);
    expect(parsed.enums.get('review_logs.reason')).toEqual(['scheduled', 'exam_boost', 'early']);
    expect(parsed.enums.get('moderation_actions.action')).toContain('appeal_rejected');
    expect(parsed.enums.get('plan_runs.trigger')).toContain('manual_edit');
    expect(parsed.enums.get('knowledge_nodes.content_status')).toContain('ai_refused');
  });

  it('every enum-style CHECK is attributed to a create table statement, once per column', () => {
    expect(parsed.problems, parsed.problems.join('\n')).toEqual([]);
  });

  it('every mismatch (missing key, extra key, or different values) is declared in KNOWN_DIFFERENCES', () => {
    const undeclared = failing.filter((m) => !KNOWN_DIFFERENCES.some((k) => k.key === m.key));
    const report = undeclared.map(describeMismatch).join('\n');
    expect(undeclared, `Undeclared mismatches (fix ENUMS or the migration, or declare them):\n${report}`).toEqual([]);
  });

  it('every KNOWN_DIFFERENCES entry still matches the exact difference it declares', () => {
    const stale: string[] = [];
    for (const known of KNOWN_DIFFERENCES) {
      const actual = failing.find((m) => m.key === known.key);
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

  it('reports same-values-different-order keys (informational, not a failure)', () => {
    if (orderOnly.length > 0) {
      console.info(`enums-sql: ${orderOnly.length} key(s) list the same values in another order:\n${orderOnly.map(describeMismatch).join('\n')}`);
    }
    expect(orderOnly.every((m) => m.onlyInSql.length === 0 && m.onlyInEnums.length === 0)).toBe(true);
  });
});
