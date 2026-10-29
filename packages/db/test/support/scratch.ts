// A fresh database per test file, built by the real migration runner. Needs TEST_PG_ADMIN_URL, a connection to
// any database of a local Postgres whose user may create databases (CI: the postgres superuser); the
// database-backed tests are skipped without it.
import pg from 'pg';
import { migrate } from '../../src/migrate.ts';

export const adminUrl = process.env.TEST_PG_ADMIN_URL;

export interface Scratch {
  url: string;
  pool: pg.Pool;
  drop(): Promise<void>;
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export async function createScratch(label: string, options: { migrated?: boolean } = {}): Promise<Scratch> {
  if (!adminUrl) throw new Error('TEST_PG_ADMIN_URL is not set');
  const name = `studify_${label}_${process.pid}_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = withDatabase(adminUrl, name);
  if (options.migrated !== false) await migrate(url);
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  return {
    url,
    pool,
    async drop() {
      await pool.end();
      const again = new pg.Client({ connectionString: adminUrl });
      await again.connect();
      await again.query(`drop database if exists ${name} with (force)`);
      await again.end();
    },
  };
}
