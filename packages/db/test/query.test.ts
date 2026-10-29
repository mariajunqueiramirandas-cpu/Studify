// The query engine against a real, migrated Postgres: the result shapes the call sites read (PostgREST's JSON forms),
// every filter and write the server code uses, rpc return shapes, and student mode under row level security.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/index.ts';
import { compileColumns } from '../src/query.ts';
import { adminUrl, createScratch, type Scratch } from './support/scratch.ts';

describe('compileColumns', () => {
  it('turns supabase-js select lists into SQL', () => {
    expect(compileColumns('*')).toBe('*');
    expect(compileColumns('id, name')).toBe('"id", "name"');
    expect(compileColumns('v:reviewed_at')).toBe('"reviewed_at" as "v"');
    expect(compileColumns('n:count::text')).toBe('"count"::text as "n"');
    expect(compileColumns('data->>kind')).toBe(`"data"->>'kind' as "kind"`);
    expect(() => compileColumns('*, questions!inner(id)')).toThrow('embedded resources are not supported');
    expect(() => compileColumns('id; drop table x')).toThrow('invalid identifier');
  });
});

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

describe.skipIf(!adminUrl)('query engine against Postgres', () => {
  let scratch: Scratch;
  let db: Db;

  beforeAll(async () => {
    scratch = await createScratch('query');
    db = createDb({ pool: scratch.pool, userMaxRows: 3 });
    await scratch.pool.query(`
      create schema qtest;
      create table qtest.items (
        id uuid primary key default gen_random_uuid(),
        name text not null,
        kind text,
        qty int,
        big bigint,
        price numeric(10,2),
        on_day date,
        at timestamptz,
        tags text[],
        meta jsonb,
        flag boolean,
        body text,
        tsv tsvector generated always as (to_tsvector('portuguese', coalesce(body, ''))) stored,
        unique (name, kind)
      );
      insert into qtest.items (id, name, kind, qty, big, price, on_day, at, tags, meta, flag, body) values
        ('00000000-0000-4000-8000-000000000001', 'alpha', 'a', 1, 9007199254740, 10.50, '2026-01-02', '2026-01-02 03:04:05.123456+00', '{x,y}', '{"links":[{"id":"k1"}],"n":1}', true, 'fotossíntese nas plantas'),
        ('00000000-0000-4000-8000-000000000002', 'beta', 'b', 2, 2, 20, '2026-02-03', '2026-02-03 00:00:00+00', '{y}', '{"n":2}', false, 'revolução francesa'),
        ('00000000-0000-4000-8000-000000000003', 'gamma', null, null, null, null, null, null, null, null, null, null);
      create function qtest.add(p_a int, p_b int default 10) returns int language sql as $$ select p_a + p_b $$;
      create function qtest.echo(p_doc jsonb) returns jsonb language sql as $$ select p_doc $$;
      create function qtest.names(p_kind text) returns setof qtest.items language sql as $$ select * from qtest.items where kind = p_kind $$;
      create function qtest.first_item() returns qtest.items language sql as $$ select * from qtest.items order by name limit 1 $$;
      create function qtest.ids() returns setof uuid language sql as $$ select id from qtest.items order by name $$;
      create function qtest.touch(p_id uuid) returns void language sql as $$ update qtest.items set qty = coalesce(qty, 0) + 1 where id = p_id $$;
      create function qtest.fail() returns int language plpgsql as $$ begin raise exception 'quota_exceeded' using hint = 'budget_exhausted'; end $$;
      grant usage on schema qtest to authenticated;
    `);
    await scratch.pool.query(`insert into auth.users (id, email) values ($1, 'alice@studify.test'), ($2, 'bob@studify.test')`, [ALICE, BOB]);
    await scratch.pool.query(
      `insert into public.profiles (id, display_name, display_name_status, birth_year, birth_month, privacy_notice_version, privacy_accepted_at)
       values ($1, 'Alice', 'approved', 2009, 1, 'v1', now()), ($2, 'Bob', 'approved', 2009, 1, 'v1', now())`,
      [ALICE, BOB],
    );
  });
  afterAll(async () => { await scratch?.drop(); });

  const q = () => db.schema('qtest');

  it('returns rows in the JSON forms PostgREST used', async () => {
    const { data, error, status } = await q().from('items').select('*').eq('name', 'alpha').single();
    expect(error).toBeNull();
    expect(status).toBe(200);
    expect(data).toMatchObject({
      id: '00000000-0000-4000-8000-000000000001',
      qty: 1,
      big: 9007199254740,
      price: 10.5,
      on_day: '2026-01-02',
      at: '2026-01-02T03:04:05.123456+00:00',
      tags: ['x', 'y'],
      meta: { links: [{ id: 'k1' }], n: 1 },
      flag: true,
    });
  });

  it('filters like supabase-js', async () => {
    const names = async (query: PromiseLike<{ data: any; error: any }>) => {
      const { data, error } = await query;
      expect(error).toBeNull();
      return (data as Array<{ name: string }>).map((r) => r.name).sort();
    };
    expect(await names(q().from('items').select('name').neq('kind', 'a'))).toEqual(['beta']);
    expect(await names(q().from('items').select('name').gt('qty', 1))).toEqual(['beta']);
    expect(await names(q().from('items').select('name').gte('at', '2026-01-02T00:00:00Z').lte('on_day', '2026-01-31'))).toEqual(['alpha']);
    expect(await names(q().from('items').select('name').in('name', ['alpha', 'gamma']))).toEqual(['alpha', 'gamma']);
    expect(await names(q().from('items').select('name').in('name', []))).toEqual([]);
    expect(await names(q().from('items').select('name').is('kind', null))).toEqual(['gamma']);
    expect(await names(q().from('items').select('name').eq('kind', null))).toEqual(['gamma']);
    expect(await names(q().from('items').select('name').not('kind', 'is', null))).toEqual(['alpha', 'beta']);
    expect(await names(q().from('items').select('name').not('name', 'in', '(alpha,beta)'))).toEqual(['gamma']);
    expect(await names(q().from('items').select('name').like('name', '%ph%'))).toEqual(['alpha']);
    expect(await names(q().from('items').select('name').ilike('name', 'BE*'))).toEqual(['beta']);
    expect(await names(q().from('items').select('name').contains('tags', ['y']))).toEqual(['alpha', 'beta']);
    expect(await names(q().from('items').select('name').contains('meta', { links: [{ id: 'k1' }] }))).toEqual(['alpha']);
    expect(await names(q().from('items').select('name').textSearch('tsv', 'plantas', { type: 'websearch', config: 'portuguese' }))).toEqual(['alpha']);
    expect(await names(q().from('items').select('name').or('kind.is.null,qty.eq.2'))).toEqual(['beta', 'gamma']);
    expect(await names(q().from('items').select('name').or('and(kind.eq.a,qty.lt.5),name.eq.gamma'))).toEqual(['alpha', 'gamma']);
    expect(await names(q().from('items').select('name').or(`at.is.null,at.lt.2026-02-01T00:00:00.000Z`))).toEqual(['alpha', 'gamma']);
    expect(await names(q().from('items').select('name').filter('name', 'in', '("alpha","beta")'))).toEqual(['alpha', 'beta']);
    expect(await names(q().from('items').select('name').match({ kind: 'b', qty: 2 }))).toEqual(['beta']);
  });

  it('orders, pages and counts', async () => {
    const desc = await q().from('items').select('name').order('qty', { ascending: false, nullsFirst: false });
    expect(desc.data.map((r: { name: string }) => r.name)).toEqual(['beta', 'alpha', 'gamma']);
    const page = await q().from('items').select('name').order('name').range(1, 2);
    expect(page.data.map((r: { name: string }) => r.name)).toEqual(['beta', 'gamma']);
    const limited = await q().from('items').select('name').order('name').limit(1);
    expect(limited.data).toEqual([{ name: 'alpha' }]);
    const head = await q().from('items').select('id', { count: 'exact', head: true }).not('kind', 'is', null);
    expect(head).toMatchObject({ data: null, count: 2, error: null });
    const counted = await q().from('items').select('name', { count: 'exact' }).limit(1);
    expect(counted.count).toBe(3);
    expect(counted.data).toHaveLength(1);
    const aliased = await q().from('items').select('v:at').eq('name', 'beta').single();
    expect(aliased.data).toEqual({ v: '2026-02-03T00:00:00+00:00' });
  });

  it('answers single and maybeSingle like PostgREST', async () => {
    expect((await q().from('items').select('name').eq('name', 'nope').maybeSingle()).data).toBeNull();
    const none = await q().from('items').select('name').eq('name', 'nope').single();
    expect(none.error?.code).toBe('PGRST116');
    expect(none.status).toBe(406);
    const many = await q().from('items').select('name').maybeSingle();
    expect(many.error?.code).toBe('PGRST116');
  });

  it('inserts, upserts, updates and deletes', async () => {
    const plain = await q().from('items').insert({ name: 'delta', kind: 'd', qty: 4 });
    expect(plain).toMatchObject({ data: null, error: null, status: 201 });

    const bulk = await q().from('items').insert([{ name: 'e1', kind: 'e', qty: 1 }, { name: 'e2', kind: 'e' }]).select('name, qty');
    expect(bulk.error).toBeNull();
    expect(bulk.data).toEqual([{ name: 'e1', qty: 1 }, { name: 'e2', qty: null }]);

    const one = await q().from('items').insert({ name: 'zeta', kind: 'z', tags: ['a', 'b'], meta: { deep: [1, 2] } }).select().single();
    expect(one.data).toMatchObject({ name: 'zeta', tags: ['a', 'b'], meta: { deep: [1, 2] } });

    const merged = await q().from('items').upsert({ name: 'delta', kind: 'd', qty: 40 }, { onConflict: 'name,kind' }).select('qty').single();
    expect(merged.data).toEqual({ qty: 40 });
    const ignored = await q().from('items').upsert({ name: 'delta', kind: 'd', qty: 99 }, { onConflict: 'name, kind', ignoreDuplicates: true }).select('qty');
    expect(ignored.data).toEqual([]);
    const byPk = await q().from('items').upsert({ id: one.data.id, name: 'zeta2' }).select('name').single();
    expect(byPk.data).toEqual({ name: 'zeta2' });

    const updated = await q().from('items').update({ qty: 5, meta: { n: 5 } }, { count: 'exact' }).eq('kind', 'e').select('name, qty, meta');
    expect(updated.count).toBe(2);
    expect(updated.data.map((r: { qty: number }) => r.qty)).toEqual([5, 5]);
    const single = await q().from('items').update({ qty: 6 }).eq('name', 'e1');
    expect(single).toMatchObject({ data: null, error: null });

    const removed = await q().from('items').delete().in('kind', ['e', 'z', 'd']).select('name');
    expect(removed.data.map((r: { name: string }) => r.name).sort()).toEqual(['delta', 'e1', 'e2', 'zeta2']);
    expect((await q().from('items').select('id', { count: 'exact', head: true })).count).toBe(3);
    expect(await q().from('items').insert([])).toMatchObject({ error: null, data: null });
  });

  it('reports database errors with their SQLSTATE and never throws', async () => {
    const dup = await q().from('items').insert({ name: 'alpha', kind: 'a' });
    expect(dup.error).toMatchObject({ code: '23505' });
    expect(dup.status).toBe(409);
    const missing = await q().from('nope').select('*');
    expect(missing.error?.code).toBe('42P01');
    const bad = await q().from('items').select('id;drop');
    expect(bad.error?.code).toBe('42602');
  });

  it('calls functions with PostgREST return shapes', async () => {
    expect((await q().rpc('add', { p_a: 1 })).data).toBe(11);
    expect((await q().rpc('add', { p_a: 1, p_b: 2 })).data).toBe(3);
    expect((await q().rpc('echo', { p_doc: ['a', { b: 1 }] })).data).toEqual(['a', { b: 1 }]);
    expect((await q().rpc('echo', { p_doc: 'text' })).data).toBe('text');
    const rows = await q().rpc('names', { p_kind: 'a' });
    expect(rows.data.map((r: { name: string }) => r.name)).toEqual(['alpha']);
    expect((await q().rpc('first_item')).data).toMatchObject({ name: 'alpha', price: 10.5 });
    expect((await q().rpc('ids')).data).toHaveLength(3);
    const touched = await q().rpc('touch', { p_id: '00000000-0000-4000-8000-000000000003' });
    expect(touched).toMatchObject({ data: null, error: null });
    const failed = await q().rpc('fail');
    expect(failed.error).toMatchObject({ code: 'P0001', message: 'quota_exceeded', hint: 'budget_exhausted' });
    expect((await q().rpc('nope')).error?.code).toBe('PGRST202');
    expect((await q().rpc('add', { p_z: 1 })).error?.code).toBe('PGRST202');
  });

  it('reads and writes the private schema', async () => {
    const key = { user_id: ALICE, function_name: 'probe', key: '0190b000-0000-7000-8000-000000000001', request_hash: 'h', status_code: 102 };
    const ins = await db.schema('private').from('idempotency_keys').insert(key).select('status_code').single();
    expect(ins.error).toBeNull();
    expect(ins.data).toEqual({ status_code: 102 });
  });

  it('runs a student’s queries under row level security', async () => {
    const alice = db.asUser({ sub: ALICE, role: 'authenticated' });
    const mine = await alice.from('profiles').select('id');
    expect(mine.error).toBeNull();
    expect(mine.data).toEqual([{ id: ALICE }]);
    const other = await alice.from('profiles').update({ display_name: 'Hacked' }).eq('id', BOB).select('id');
    expect(other.data).toEqual([]);
    // A plain insert has no RETURNING, so it does not need the read policy to see the new row (return=minimal).
    const subject = await alice.from('subjects').insert({ owner_profile_id: ALICE, created_by: ALICE, name: 'Física', color: '#0000aa', icon: 'atom' });
    expect(subject.error).toBeNull();
    expect((await alice.from('subjects').select('name')).data).toEqual([{ name: 'Física' }]);
    const forged = await alice.from('subjects').insert({ owner_profile_id: BOB, created_by: BOB, name: 'X', color: '#0000aa', icon: 'atom' });
    expect(forged.error?.code).toBe('42501');
    const bob = db.asUser({ sub: BOB, role: 'authenticated' });
    expect((await bob.from('subjects').select('id')).data).toEqual([]);
    const uid = await alice.select<{ uid: string }>('select auth.uid() as uid');
    expect(uid).toEqual([{ uid: ALICE }]);
  });

  it('caps a student’s unlimited read at max rows, and the service client is not capped', async () => {
    const student = db.asUser({ sub: ALICE });
    const capped = await student.schema('qtest').from('items').select('id');
    expect(capped.error?.code).toBe('42501');
    await scratch.pool.query('grant select on qtest.items to authenticated');
    await scratch.pool.query(`insert into qtest.items (name) select 'bulk' || g from generate_series(1, 5) g`);
    expect((await student.schema('qtest').from('items').select('id')).data).toHaveLength(3);
    expect((await q().from('items').select('id')).data.length).toBeGreaterThan(3);
  });

  it('commits a transaction whole or not at all', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.schema('qtest').from('items').insert({ name: 'tx1' });
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect((await q().from('items').select('id').eq('name', 'tx1')).data).toEqual([]);
    await db.transaction(async (tx) => {
      await tx.schema('qtest').from('items').insert({ name: 'tx2' });
    });
    expect((await q().from('items').select('name').eq('name', 'tx2')).data).toEqual([{ name: 'tx2' }]);
  });

  it('answers raw selects as JSON rows', async () => {
    const rows = await db.select<{ at: string; n: number }>(`select at, qty as n from qtest.items where name = $1`, ['alpha']);
    expect(rows).toEqual([{ at: '2026-01-02T03:04:05.123456+00:00', n: 1 }]);
  });
});
