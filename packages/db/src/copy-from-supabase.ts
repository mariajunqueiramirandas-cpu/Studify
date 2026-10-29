// One-time move from the Supabase project to Studify's own Postgres and file store (ADR 0012, deployment.md §8).
// Run it once, in a maintenance window, against an empty target:
//
//   docker compose exec api bun packages/db/src/copy-from-supabase.ts
//
// with, in the api container's environment:
//   SOURCE_DATABASE_URL        the Supabase session pooler string (Project Settings > Database), read only
//   DATABASE_URL               the target (already set in the api container)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   to download the stored files (already set)
//   STORAGE_DIR                where the files go (already set)
//
// It migrates the target, copies the accounts (auth.users: id, email, created_at, last sign-in, suspension), every
// row of the public and private schemas, the storage.objects metadata and the files themselves. Triggers and
// foreign keys are off while rows are copied (session_replication_role = replica), so table order does not matter;
// identity sequences are moved past the copied ids at the end. Reference data the migrations seeded is replaced by
// the source's. A target that already has profiles is refused.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { migrate } from './migrate.ts';
import { validBucket, validObjectName } from './storage.ts';

const BATCH = 2000;

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

async function tablesOf(target: pg.Client): Promise<Array<{ schema: string; table: string }>> {
  const res = await target.query<{ schema: string; table: string }>(
    `select n.nspname as schema, c.relname as table from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and n.nspname in ('public', 'private') and not c.relispartition order by 1, 2`,
  );
  return res.rows;
}

async function copyableColumns(source: pg.Client, target: pg.Client, schema: string, table: string): Promise<string[]> {
  const q = `select column_name as name from information_schema.columns
              where table_schema = $1 and table_name = $2 and is_generated = 'NEVER' order by ordinal_position`;
  const [src, dst] = await Promise.all([source.query<{ name: string }>(q, [schema, table]), target.query<{ name: string }>(q, [schema, table])]);
  const there = new Set(src.rows.map((r) => r.name));
  return dst.rows.map((r) => r.name).filter((c) => there.has(c));
}

async function copyTable(source: pg.Client, target: pg.Client, schema: string, table: string, columns: string[]): Promise<number> {
  const list = columns.map((c) => `"${c}"`).join(', ');
  const qualified = `"${schema}"."${table}"`;
  let copied = 0;
  for (let offset = 0; ; offset += BATCH) {
    const page = await source.query<{ rows: unknown[] | null }>(
      `select json_agg(t) as rows from (select ${list} from ${qualified} order by ctid limit ${BATCH} offset ${offset}) t`,
    );
    const rows = page.rows[0]?.rows ?? [];
    if (rows.length === 0) break;
    await target.query(`insert into ${qualified} (${list}) select ${list} from json_populate_recordset(null::${qualified}, $1::json)`, [JSON.stringify(rows)]);
    copied += rows.length;
    if (rows.length < BATCH) break;
  }
  return copied;
}

async function resetSequences(target: pg.Client): Promise<void> {
  const seqs = await target.query<{ seq: string; tbl: string; col: string }>(
    `select s.oid::regclass::text as seq, t.oid::regclass::text as tbl, a.attname as col
       from pg_class s join pg_depend d on d.objid = s.oid and d.deptype in ('a', 'i')
       join pg_class t on t.oid = d.refobjid join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
       join pg_namespace n on n.oid = t.relnamespace
      where s.relkind = 'S' and n.nspname in ('public', 'private', 'storage')`,
  );
  for (const s of seqs.rows) {
    await target.query(`select setval($1, greatest((select coalesce(max("${s.col}"), 0) from ${s.tbl}), 1))`, [s.seq]);
  }
}

async function main(): Promise<void> {
  const sourceUrl = env('SOURCE_DATABASE_URL');
  const targetUrl = env('DATABASE_URL');
  const supabaseUrl = env('SUPABASE_URL').replace(/\/+$/, '');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const storageDir = env('STORAGE_DIR');

  console.log('migrating the target');
  await migrate(targetUrl, { log: (m, f) => console.log(`  ${m}`, f ?? '') });

  const source = new pg.Client({ connectionString: sourceUrl, application_name: 'studify-copy' });
  const target = new pg.Client({ connectionString: targetUrl, application_name: 'studify-copy' });
  await source.connect();
  await target.connect();
  try {
    const existing = await target.query<{ n: number }>('select count(*)::int as n from public.profiles');
    if ((existing.rows[0]?.n ?? 0) > 0) throw new Error('the target already has profiles; this copy is for an empty database');
    await source.query('set default_transaction_read_only = on');

    await target.query('begin');
    await target.query('set local session_replication_role = replica');

    // The migrations seed reference data (buckets aside); the source has the same rows, possibly edited since. The
    // source wins: the seeded tables are emptied first, then everything is copied.
    const seeded: string[] = [];
    for (const { schema, table } of await tablesOf(target)) {
      const any = await target.query(`select exists (select 1 from "${schema}"."${table}") as has`);
      if (any.rows[0]?.has) seeded.push(`"${schema}"."${table}"`);
    }
    // Nothing is copied yet, so cascading into the (empty) tables that reference them loses nothing.
    if (seeded.length > 0) await target.query(`truncate ${seeded.join(', ')} cascade`);

    const users = await source.query(`select id, email, created_at, last_sign_in_at, banned_until from auth.users`);
    for (const u of users.rows) {
      await target.query(`insert into auth.users (id, email, created_at, last_sign_in_at, banned_until) values ($1, $2, $3, $4, $5)`, [u.id, u.email, u.created_at, u.last_sign_in_at, u.banned_until]);
    }
    console.log(`auth.users: ${users.rows.length}`);

    for (const { schema, table } of await tablesOf(target)) {
      const columns = await copyableColumns(source, target, schema, table);
      if (columns.length === 0) {
        console.log(`${schema}.${table}: not in the source, skipped`);
        continue;
      }
      const n = await copyTable(source, target, schema, table, columns);
      if (n > 0) console.log(`${schema}.${table}: ${n}`);
    }

    const objects = await source.query<{ bucket_id: string; name: string; owner: string | null; metadata: unknown; created_at: string; updated_at: string }>(
      `select bucket_id, name, owner, metadata, created_at, updated_at from storage.objects order by bucket_id, name`,
    );
    let files = 0;
    for (const o of objects.rows) {
      if (!validBucket(o.bucket_id) || !validObjectName(o.name)) {
        console.warn(`skipped ${o.bucket_id}/${o.name}: not a valid name`);
        continue;
      }
      const res = await fetch(`${supabaseUrl}/storage/v1/object/${o.bucket_id}/${o.name.split('/').map(encodeURIComponent).join('/')}`, {
        headers: { apikey: serviceKey, ...(serviceKey.startsWith('sb_') ? {} : { Authorization: `Bearer ${serviceKey}` }) },
      });
      if (!res.ok) {
        console.warn(`skipped ${o.bucket_id}/${o.name}: download answered ${res.status}`);
        continue;
      }
      const file = path.join(storageDir, o.bucket_id, ...o.name.split('/'));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, new Uint8Array(await res.arrayBuffer()));
      await target.query(
        `insert into storage.objects (bucket_id, name, owner, metadata, created_at, updated_at) values ($1, $2, $3, $4, $5, $6)
         on conflict (bucket_id, name) do nothing`,
        [o.bucket_id, o.name, o.owner, o.metadata, o.created_at, o.updated_at],
      );
      files += 1;
    }
    console.log(`files: ${files} of ${objects.rows.length}`);

    await target.query('commit');
    await resetSequences(target);
    console.log('done. Point the app at the new API build and check a sign-in, a material and a file.');
  } catch (err) {
    await target.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
