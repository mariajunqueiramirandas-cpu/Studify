// Schema migrations (ADR 0012). Applies packages/db/migrations/*.sql in name order, each file in one transaction,
// and records it in migrations.applied. The API runs this before it starts serving (apps/api/src/server.ts), so a
// deploy always meets the schema its code needs; `pnpm --filter @studify/db migrate` does the same by hand.
// An advisory lock keeps two processes from migrating at once. A file already applied is never run again; when its
// text changed since, a warning names it (comments are edited, applied SQL is not).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

const LOCK_KEY = "hashtextextended('studify-migrations', 0)";

export interface MigrationFile {
  /** The timestamp prefix, e.g. 20260101000000. */
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateOptions {
  dir?: string;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export function readMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((file) => /^\d{14}_[a-z0-9_]+\.sql$/.test(file))
    .sort()
    .map((file) => {
      const sql = readFileSync(path.join(dir, file), 'utf8');
      return {
        version: file.slice(0, 14),
        name: file.slice(15, -4),
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

/** Applies the pending migrations. Returns the file names applied, in order. */
export async function migrate(connectionString: string, options: MigrateOptions = {}): Promise<string[]> {
  const log = options.log ?? (() => undefined);
  const files = readMigrations(options.dir);
  const client = new pg.Client({ connectionString, application_name: 'studify-migrate' });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`select pg_advisory_lock(${LOCK_KEY})`);
    await client.query(`create schema if not exists migrations;
      create table if not exists migrations.applied (
        version    text primary key,
        name       text not null,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )`);
    const done = new Map(
      (await client.query<{ version: string; checksum: string }>('select version, checksum from migrations.applied')).rows.map((r) => [r.version, r.checksum]),
    );
    for (const file of files) {
      const known = done.get(file.version);
      if (known !== undefined) {
        if (known !== file.checksum) log('migration changed after it was applied', { migration: `${file.version}_${file.name}` });
        continue;
      }
      await client.query('begin');
      try {
        await client.query(file.sql);
        await client.query('insert into migrations.applied (version, name, checksum) values ($1, $2, $3)', [file.version, file.name, file.checksum]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`migration ${file.version}_${file.name} failed: ${message}`);
      }
      applied.push(`${file.version}_${file.name}`);
      log('migration applied', { migration: `${file.version}_${file.name}` });
    }
  } finally {
    await client.query(`select pg_advisory_unlock(${LOCK_KEY})`).catch(() => undefined);
    await client.end();
  }
  return applied;
}

// CLI: DATABASE_URL=postgresql://... pnpm --filter @studify/db migrate
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  migrate(url, { log: (message, fields) => console.log(message, fields ?? '') })
    .then((applied) => console.log(applied.length === 0 ? 'schema is up to date' : `applied ${applied.length} migration(s)`))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
