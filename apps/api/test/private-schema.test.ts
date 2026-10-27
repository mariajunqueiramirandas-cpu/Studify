import { afterAll, beforeAll, test } from 'bun:test';
// private-schema.ts against a real Postgres. Runs when TEST_DATABASE_URL points at a scratch database;
// skipped otherwise. It creates its own `private` tables (copies of the migration columns that matter).
import pg from 'pg';
import { assert, assertEquals } from './assert.ts';
import { PrivateQuery, privateSchema } from '../src/shared/private-schema.ts';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? test : test.skip;
let pool: pg.Pool;

beforeAll(async () => {
  if (!url) return;
  pool = new pg.Pool({ connectionString: url, max: 2 });
  await pool.query(`
    drop schema if exists private cascade;
    create schema private;
    create table private.idempotency_keys (
      user_id uuid not null, function_name text not null, key uuid not null, request_hash text not null,
      status_code int not null, response jsonb, created_at timestamptz not null default now(),
      primary key (user_id, function_name, key));
    create table private.question_served (
      quiz_attempt_id uuid not null, question_id uuid not null, served_at timestamptz not null default now(),
      deadline_at timestamptz not null, primary key (quiz_attempt_id, question_id));
    create function private.ai_budget_reserve(p_user uuid, p_class_group uuid, p_feature text, p_budget_class text, p_estimate_micro_usd bigint)
      returns uuid language plpgsql as $$
      begin
        if p_estimate_micro_usd > 1000 then
          raise exception 'budget_exhausted' using detail = 'user', hint = 'resets_at=2026-10-28';
        end if;
        return '00000000-0000-7000-8000-000000000001'::uuid;
      end $$;
  `);
});

afterAll(async () => {
  if (!url) return;
  await pool.query('drop schema if exists private cascade');
  await pool.end();
});

const USER = '00000000-0000-7000-8000-0000000000aa';
const KEY = '00000000-0000-7000-8000-0000000000bb';

maybe('insert, maybeSingle, update, conflict and delete on private.idempotency_keys', async () => {
  const table = () => privateSchema(pool).from('idempotency_keys');
  const row = { user_id: USER, function_name: 'ingest-start', key: KEY, request_hash: 'h', status_code: 102, response: null, created_at: new Date().toISOString() };
  assertEquals((await table().insert(row)).error, null);
  const dup = await table().insert(row);
  assertEquals(dup.error?.code, '23505');

  const found = await table().select('request_hash, status_code, response, created_at').eq('user_id', USER).eq('function_name', 'ingest-start').eq('key', KEY).maybeSingle();
  assertEquals(found.error, null);
  const data = found.data as Record<string, unknown>;
  assertEquals(data.status_code, 102);
  assertEquals(typeof data.created_at, 'string', 'timestamps come back as strings, like PostgREST');

  const stored = { status: 202, contentType: 'application/json', body: '{"ok":true}' };
  assertEquals((await table().update({ status_code: 202, response: stored }).eq('user_id', USER).eq('function_name', 'ingest-start').eq('key', KEY)).error, null);
  const after = await table().select('response').eq('key', KEY).maybeSingle();
  assertEquals((after.data as { response: unknown }).response, stored, 'jsonb round-trips');

  assertEquals((await table().delete().eq('user_id', USER).eq('key', KEY)).error, null);
  assertEquals((await table().select('key').eq('key', KEY).maybeSingle()).data, null);
});

maybe('upsert with ignoreDuplicates and ordered selects on private.question_served', async () => {
  const qs = () => privateSchema(pool).from('question_served');
  const attempt = '00000000-0000-7000-8000-0000000000c1';
  const q1 = '00000000-0000-7000-8000-0000000000d1';
  const q2 = '00000000-0000-7000-8000-0000000000d2';
  const deadline = '2030-01-01T00:00:00.000Z';
  assertEquals((await qs().upsert({ quiz_attempt_id: attempt, question_id: q2, served_at: '2029-01-02T00:00:00.000Z', deadline_at: deadline }, { onConflict: 'quiz_attempt_id,question_id', ignoreDuplicates: true })).error, null);
  assertEquals((await qs().upsert({ quiz_attempt_id: attempt, question_id: q1, served_at: '2029-01-01T00:00:00.000Z', deadline_at: deadline }, { onConflict: 'quiz_attempt_id,question_id', ignoreDuplicates: true })).error, null);
  const again = await qs().upsert({ quiz_attempt_id: attempt, question_id: q1, served_at: '2029-06-01T00:00:00.000Z', deadline_at: deadline }, { onConflict: 'quiz_attempt_id,question_id', ignoreDuplicates: true });
  assertEquals(again.error, null);
  const rows = (await qs().select('question_id, served_at, deadline_at').eq('quiz_attempt_id', attempt).order('served_at', { ascending: true })).data as Array<{ question_id: string; served_at: string }>;
  assertEquals(rows.map((r) => r.question_id), [q1, q2]);
  assertEquals(rows[0]!.served_at, '2029-01-01T00:00:00.000Z', 'the duplicate was ignored');
  const many = await qs().select('question_id').eq('quiz_attempt_id', attempt).maybeSingle();
  assertEquals(many.error?.code, 'PGRST116', 'maybeSingle with two rows errors like PostgREST');
});

maybe('rpc passes named arguments and maps raised errors to PostgREST fields', async () => {
  const ok = await privateSchema(pool).rpc('ai_budget_reserve', { p_user: USER, p_class_group: null, p_feature: 'ING-01', p_budget_class: 'content', p_estimate_micro_usd: 10 });
  assertEquals(ok, { data: '00000000-0000-7000-8000-000000000001', error: null });
  const refused = await privateSchema(pool).rpc('ai_budget_reserve', { p_user: USER, p_class_group: null, p_feature: 'ING-01', p_budget_class: 'content', p_estimate_micro_usd: 5000 });
  assertEquals(refused.error?.message, 'budget_exhausted');
  assertEquals(refused.error?.details, 'user');
  assertEquals(refused.error?.hint, 'resets_at=2026-10-28');
});

test('identifiers are validated, never interpolated raw', () => {
  const fake = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
  const q = new PrivateQuery(fake, 'idempotency_keys').select('key').eq('user_id', "x'; drop table y; --");
  const built = q.build();
  assertEquals(built.text, 'select "key" from "private"."idempotency_keys" where "user_id" = $1');
  assertEquals(built.values, ["x'; drop table y; --"]);
  let threw = false;
  try {
    new PrivateQuery(fake, 'idempotency_keys; drop').build();
  } catch {
    threw = true;
  }
  assert(threw, 'a bad table name is refused');
});
