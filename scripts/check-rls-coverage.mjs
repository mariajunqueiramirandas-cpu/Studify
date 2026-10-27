#!/usr/bin/env node
// RLS coverage gate (testing-strategy.md §4).
//
// Lists every table in schema `public` of the test database and fails when a table
//   1. has row level security disabled, or
//   2. is not mentioned in any supabase/tests/*.test.sql file (comments do not count).
//
// Usage: DATABASE_URL=postgresql://postgres:postgres@localhost:5432/studify_test node scripts/check-rls-coverage.mjs
// Run `bash supabase/tests/run.sh` (or `pnpm db:test`) first so the schema exists.
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `pg` is hoisted to the root node_modules by the pnpm workspace (node-linker=hoisted).
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = join(ROOT, 'supabase', 'tests');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/studify_test';

/** Removes `-- line` and block comments; quoted string literals are kept as they are. */
function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Returns the table names (from `tables`) that appear as whole words in at least one test file. */
function tablesMentionedInTests(tables, testSources) {
  const mentioned = new Set();
  for (const source of testSources) {
    for (const table of tables) {
      if (mentioned.has(table)) continue;
      const word = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(table)}(?![A-Za-z0-9_])`);
      if (word.test(source)) mentioned.add(table);
    }
  }
  return mentioned;
}

function loadTestSources() {
  const files = readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('.test.sql'))
    .sort();
  if (files.length === 0) {
    throw new Error(`no *.test.sql files found in ${TESTS_DIR}`);
  }
  return files.map((f) => ({ name: f, sql: stripSqlComments(readFileSync(join(TESTS_DIR, f), 'utf8')) }));
}

async function main() {
  const testFiles = loadTestSources();
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  let tables;
  try {
    const { rows } = await client.query(`
      select c.relname as name, c.relrowsecurity as rls_enabled
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')
       order by c.relname`);
    tables = rows;
  } finally {
    await client.end();
  }

  if (tables.length === 0) {
    console.error('rls-coverage: no tables in schema public. Build the test database first (pnpm db:test).');
    process.exit(1);
  }

  const names = tables.map((t) => t.name);
  const mentioned = tablesMentionedInTests(
    names,
    testFiles.map((f) => f.sql),
  );

  const failures = [];
  console.log(`rls-coverage: ${tables.length} table(s) in schema public, ${testFiles.length} test file(s)`);
  for (const table of tables) {
    const problems = [];
    if (!table.rls_enabled) problems.push('RLS disabled');
    if (!mentioned.has(table.name)) problems.push('no pgTAP test file mentions it');
    const status = problems.length === 0 ? 'ok  ' : 'FAIL';
    console.log(`  ${status}  ${table.name}${problems.length ? `  (${problems.join('; ')})` : ''}`);
    if (problems.length) failures.push({ table: table.name, problems });
  }

  if (failures.length > 0) {
    console.error(`\nrls-coverage: ${failures.length} table(s) fail the gate:`);
    for (const f of failures) console.error(`  - ${f.table}: ${f.problems.join('; ')}`);
    process.exit(1);
  }
  console.log('\nrls-coverage: all tables have RLS enabled and pgTAP coverage.');
}

main().catch((err) => {
  console.error(`rls-coverage: ${err.message}`);
  process.exit(1);
});
