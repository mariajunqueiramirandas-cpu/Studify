import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrate, readMigrations } from '../src/migrate.ts';
import { adminUrl, createScratch, type Scratch } from './support/scratch.ts';

describe('readMigrations', () => {
  it('reads the repository migrations in name order, platform first', () => {
    const files = readMigrations();
    expect(files[0]?.name).toBe('platform');
    expect(files.map((f) => f.version)).toEqual([...files.map((f) => f.version)].sort());
    expect(new Set(files.map((f) => f.version)).size).toBe(files.length);
  });
});

describe.skipIf(!adminUrl)('migrate against Postgres', () => {
  let db: Scratch;
  beforeAll(async () => { db = await createScratch('migrate', { migrated: false }); });
  afterAll(async () => { await db?.drop(); });

  it('builds the whole schema on an empty database, then has nothing left to do', async () => {
    const applied = await migrate(db.url);
    expect(applied.length).toBe(readMigrations().length);
    expect(await migrate(db.url)).toEqual([]);
    const tables = await db.pool.query(`select count(*)::int as n from pg_tables where schemaname = 'public'`);
    expect(tables.rows[0].n).toBeGreaterThan(100);
    const roles = await db.pool.query(`select array_agg(rolname::text order by rolname) as r from pg_roles where rolname in ('anon','authenticated','service_role')`);
    expect(roles.rows[0].r).toEqual(['anon', 'authenticated', 'service_role']);
  });

  it('rolls a failing file back whole and reports which one failed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'studify-migrations-'));
    writeFileSync(path.join(dir, '20990101000000_good.sql'), 'create table public.migrate_probe (id int);');
    writeFileSync(path.join(dir, '20990102000000_bad.sql'), 'create table public.migrate_probe_2 (id int); select missing_function();');
    await expect(migrate(db.url, { dir })).rejects.toThrow('migration 20990102000000_bad failed');
    const probe = await db.pool.query(`select to_regclass('public.migrate_probe') as a, to_regclass('public.migrate_probe_2') as b`);
    expect(probe.rows[0]).toEqual({ a: 'migrate_probe', b: null });
    const recorded = await db.pool.query(`select version from migrations.applied where version like '2099%'`);
    expect(recorded.rows).toEqual([{ version: '20990101000000' }]);
  });
});
