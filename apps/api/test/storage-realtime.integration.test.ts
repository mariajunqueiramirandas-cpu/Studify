import { afterAll, beforeAll, expect, test } from 'bun:test';
// Files and realtime against a real, migrated Postgres (RUNTIME_TEST_DATABASE_URL, built by packages/db/pgtap/run.sh):
// uploads go through the storage policies as the student, signed links grant one file, realtime channels follow the
// realtime policies, and row changes reach a subscriber through the triggers and LISTEN.
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createDb, FileStore, type DbAuth } from '@studify/db';
import { createApp } from '../src/app.ts';
import { RealtimeHub } from '../src/realtime/hub.ts';
import { listenRowChanges } from '../src/realtime/listener.ts';
import type { P2Deps } from '../src/shared-p2/deps.ts';
import { createFakeDb, createFakeDeps } from './p2_fakes.ts';

const url = process.env.RUNTIME_TEST_DATABASE_URL;
const maybe = url ? test : test.skip;

const ALICE = '0190b000-0000-7000-8000-00000000c001';
const BOB = '0190b000-0000-7000-8000-00000000c002';
const JOB = '0190b000-0000-7000-8000-00000000c003';
const TOKENS: Record<string, { id: string; email: string }> = {
  'token-alice': { id: ALICE, email: 'alice-int@studify.test' },
  'token-bob': { id: BOB, email: 'bob-int@studify.test' },
};

let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let files: FileStore;
let hub: RealtimeHub;
let listener: { stop(): Promise<void> } | undefined;

async function cleanup(): Promise<void> {
  await pool.query('delete from public.ai_jobs where id = $1', [JOB]);
  await pool.query(`delete from storage.objects where bucket_id = 'photos' and name like any(array[$1 || '/%', $2 || '/%'])`, [ALICE, BOB]);
  await pool.query('delete from public.profiles where id = any($1::uuid[])', [[ALICE, BOB]]);
  await pool.query('delete from auth.users where id = any($1::uuid[])', [[ALICE, BOB]]);
}

beforeAll(async () => {
  if (!url) return;
  pool = new pg.Pool({ connectionString: url, max: 8 });
  await cleanup();
  await pool.query(`insert into auth.users (id, email) values ($1, 'alice-int@studify.test'), ($2, 'bob-int@studify.test')`, [ALICE, BOB]);
  await pool.query(
    `insert into public.profiles (id, display_name, display_name_status, birth_year, birth_month, privacy_notice_version, privacy_accepted_at)
     values ($1, 'Alice', 'approved', 2009, 1, 'v1', now()), ($2, 'Bob', 'approved', 2009, 1, 'v1', now())`,
    [ALICE, BOB],
  );
  const auth = {
    getUser: async (jwt: string) => {
      const user = TOKENS[jwt];
      return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'invalid token', status: 401 } };
    },
    admin: {},
  } as unknown as DbAuth;
  files = new FileStore({ sql: pool, root: mkdtempSync(path.join(tmpdir(), 'studify-api-files-')), signingKey: 'k'.repeat(40), publicUrl: 'http://localhost/api' });
  const db = createDb({ pool, auth, storage: files.client() });
  hub = new RealtimeHub(db, { heartbeatMs: 0, newId: () => crypto.randomUUID() });
  const fake = createFakeDeps({ db: createFakeDb() });
  const deps: P2Deps = {
    ...fake.deps,
    db,
    asUser: (user) => db.asUser({ sub: user.userId, role: 'authenticated', email: user.email }),
    newId: () => crypto.randomUUID(),
    realtime: hub,
    files,
  };
  app = createApp(deps, path.join(tmpdir(), 'no-site'));
  listener = listenRowChanges(url, (change) => void hub.rowChanged(change));
  await new Promise((resolve) => setTimeout(resolve, 300));
});

afterAll(async () => {
  if (!url) return;
  hub.closeAll();
  await listener?.stop();
  await cleanup();
  await pool.end();
});

function auth(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...extra };
}

/** Calls a function over SSE and returns its done.result, or throws the error event. */
async function call(name: string, token: string, body: unknown): Promise<any> {
  const res = await app.request(`/api/${name}`, {
    method: 'POST',
    headers: auth(token, { 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
    body: JSON.stringify(body),
  });
  expect(res.headers.get('content-type')).toStartWith('text/event-stream');
  const events = parseEvents(await res.text());
  const done = events.find((e) => e.event === 'done');
  if (done) return (done.data as { result: unknown }).result;
  const error = events.find((e) => e.event === 'error');
  throw Object.assign(new Error('call failed'), { body: error?.data });
}

function parseEvents(text: string): Array<{ event: string; data: unknown }> {
  return text
    .split('\n\n')
    .map((frame) => ({ event: /^event: (.+)$/m.exec(frame)?.[1], data: /^data: (.+)$/m.exec(frame)?.[1] }))
    .filter((f): f is { event: string; data: string } => !!f.event && !!f.data)
    .map((f) => ({ event: f.event, data: JSON.parse(f.data) }));
}

/** Opens a realtime stream and collects its events as they arrive. */
async function openStream(token: string) {
  const res = await app.request('/api/realtime-stream', { method: 'POST', headers: auth(token, { Accept: 'text/event-stream' }) });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: any }> = [];
  let buffer = '';
  void (async () => {
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      events.push(...parseEvents(frames.join('\n\n') + '\n\n'));
    }
  })();
  const waitFor = async (pred: (e: { event: string; data: any }) => boolean, ms = 3000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no matching event; got ${JSON.stringify(events)}`);
  };
  const ready = await waitFor((e) => e.event === 'ready');
  return { id: ready.data.connection_id as string, events, waitFor, close: () => reader.cancel() };
}

maybe('a student uploads into their own folder only, as the storage policies say', async () => {
  const own = await app.request(`/api/storage/object/photos/${ALICE}/c1/1.jpg`, { method: 'POST', headers: auth('token-alice', { 'Content-Type': 'image/jpeg', 'x-upsert': 'true' }), body: new Uint8Array([1, 2, 3]) });
  expect(own.status).toBe(200);
  expect(await readFile(files.filePath('photos', `${ALICE}/c1/1.jpg`))).toEqual(Buffer.from([1, 2, 3]));
  const owner = await pool.query(`select owner, metadata->>'size' as size from storage.objects where bucket_id = 'photos' and name = $1`, [`${ALICE}/c1/1.jpg`]);
  expect(owner.rows[0]).toEqual({ owner: ALICE, size: '3' });

  const other = await app.request(`/api/storage/object/photos/${BOB}/c1/1.jpg`, { method: 'POST', headers: auth('token-alice', { 'Content-Type': 'image/jpeg' }), body: new Uint8Array([9]) });
  expect(other.status).toBe(403);
  expect((await other.json()).error.code).toBe('forbidden');
  const wrongType = await app.request(`/api/storage/object/photos/${ALICE}/c1/2.gif`, { method: 'POST', headers: auth('token-alice', { 'Content-Type': 'image/gif' }), body: new Uint8Array([9]) });
  expect(wrongType.status).toBe(400);
  const anonymous = await app.request(`/api/storage/object/photos/${ALICE}/c1/3.jpg`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array([9]) });
  expect(anonymous.status).toBe(401);
});

maybe('a resumable upload stores the file once its last chunk arrives', async () => {
  const meta = (k: string, v: string) => `${k} ${Buffer.from(v).toString('base64')}`;
  const created = await app.request('/api/storage/upload/resumable', {
    method: 'POST',
    headers: auth('token-alice', { 'Tus-Resumable': '1.0.0', 'Upload-Length': '10', 'Upload-Metadata': [meta('bucketName', 'photos'), meta('objectName', `${ALICE}/c2/big.jpg`), meta('contentType', 'image/jpeg')].join(',') }),
  });
  expect(created.status).toBe(201);
  const location = created.headers.get('location')!;
  expect(location).toStartWith('/api/storage/upload/resumable/');
  const patch = (offset: number, bytes: number[]) =>
    app.request(location, { method: 'PATCH', headers: auth('token-alice', { 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' }), body: new Uint8Array(bytes) });
  expect((await patch(0, [0, 1, 2, 3, 4, 5])).headers.get('upload-offset')).toBe('6');
  expect((await patch(0, [9])).status).toBe(409);
  const head = await app.request(location, { method: 'HEAD', headers: auth('token-alice', { 'Tus-Resumable': '1.0.0' }) });
  expect(head.headers.get('upload-offset')).toBe('6');
  expect((await app.request(location, { method: 'HEAD', headers: auth('token-bob') })).status).toBe(404);
  expect((await patch(6, [6, 7, 8, 9])).status).toBe(204);
  expect(await readFile(files.filePath('photos', `${ALICE}/c2/big.jpg`))).toEqual(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));

  const forbidden = await app.request('/api/storage/upload/resumable', {
    method: 'POST',
    headers: auth('token-alice', { 'Upload-Length': '4', 'Upload-Metadata': [meta('bucketName', 'photos'), meta('objectName', `${BOB}/x.jpg`), meta('contentType', 'image/jpeg')].join(',') }),
  });
  expect(forbidden.status).toBe(403);
});

maybe('storage-sign signs only what the student may read; the link serves the file and ranges', async () => {
  const { urls } = await call('storage-sign', 'token-alice', { bucket: 'photos', paths: [`${ALICE}/c2/big.jpg`, `${BOB}/nope.jpg`] });
  expect(urls[1]).toEqual({ path: `${BOB}/nope.jpg`, signedUrl: null, error: 'not_found' });
  const signed = new URL(urls[0].signedUrl);
  const whole = await app.request(signed.pathname + signed.search);
  expect(whole.status).toBe(200);
  expect(whole.headers.get('content-type')).toBe('image/jpeg');
  expect(new Uint8Array(await whole.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
  const part = await app.request(signed.pathname + signed.search, { headers: { Range: 'bytes=2-4' } });
  expect(part.status).toBe(206);
  expect(part.headers.get('content-range')).toBe('bytes 2-4/10');
  expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array([2, 3, 4]));
  expect((await app.request(signed.pathname + '?token=forged.x')).status).toBe(403);
  const bobs = await call('storage-sign', 'token-bob', { bucket: 'photos', paths: [`${ALICE}/c2/big.jpg`] });
  expect(bobs.urls[0].signedUrl).toBeNull();
});

maybe('realtime: channels follow the realtime policies, row changes and broadcasts arrive over SSE', async () => {
  const alice = await openStream('token-alice');
  const join = (topic: string, presence?: object) => call('realtime-join', 'token-alice', { connection_id: alice.id, topic, ...(presence ? { presence } : {}) });

  expect(await join(`rows:ai_jobs:user_id=${ALICE}`)).toEqual({ topic: `rows:ai_jobs:user_id=${ALICE}`, presence: {} });
  await expect(join(`rows:ai_jobs:user_id=${BOB}`)).rejects.toMatchObject({ body: { code: 'forbidden' } });
  await expect(join('rows:profiles:id=' + BOB)).rejects.toMatchObject({ body: { code: 'invalid_request' } });
  expect((await join(`user:${ALICE}`)).topic).toBe(`user:${ALICE}`);
  await expect(join(`user:${BOB}`)).rejects.toMatchObject({ body: { code: 'forbidden' } });
  // Presence is only for battles, duels and rooms (realtime_presence_send).
  await expect(join(`user:${ALICE}`, { key: ALICE, payload: {} })).rejects.toMatchObject({ body: { code: 'forbidden' } });
  await expect(call('realtime-track', 'token-alice', { connection_id: alice.id, topic: `user:${ALICE}`, key: ALICE, payload: { status: 'here' } })).rejects.toMatchObject({ body: { code: 'forbidden' } });
  await expect(call('realtime-track', 'token-alice', { connection_id: alice.id, topic: `battle:${JOB}`, key: ALICE, payload: {} })).rejects.toMatchObject({ body: { code: 'not_found' } });
  // Another student cannot act on Alice's stream.
  await expect(call('realtime-join', 'token-bob', { connection_id: alice.id, topic: `user:${BOB}` })).rejects.toMatchObject({ body: { code: 'not_found' } });

  await pool.query(`insert into public.ai_jobs (id, type, user_id, status) values ($1, 'podcast.generate', $2, 'running')`, [JOB, ALICE]);
  const change = await alice.waitFor((e) => e.event === 'change' && e.data.new?.id === JOB);
  expect(change.data).toMatchObject({ topic: `rows:ai_jobs:user_id=${ALICE}`, table: 'ai_jobs', op: 'INSERT', new: { status: 'running' } });
  await pool.query(`update public.ai_jobs set status = 'succeeded' where id = $1`, [JOB]);
  await alice.waitFor((e) => e.event === 'change' && e.data.op === 'UPDATE' && e.data.new?.status === 'succeeded');

  hub.broadcast(`user:${ALICE}`, 'nudge', { n: 1 });
  const nudge = await alice.waitFor((e) => e.event === 'broadcast');
  expect(nudge.data).toEqual({ topic: `user:${ALICE}`, event: 'nudge', payload: { n: 1 } });

  expect(await call('realtime-leave', 'token-alice', { connection_id: alice.id, topic: `user:${ALICE}` })).toEqual({ left: true });
  expect(hub.broadcast(`user:${ALICE}`, 'nudge', { n: 2 })).toBe(0);
  await alice.close();
});

maybe('the local account copy follows Supabase Auth: created on first sight, then email, sign-in and suspension', async () => {
  const { mirrorUser } = await import('../src/shared/supabase-auth.ts');
  const id = '0190b000-0000-7000-8000-00000000c009';
  await pool.query('delete from auth.users where id = $1', [id]);
  await mirrorUser(pool, { id, email: 'new@studify.test', created_at: '2026-10-01T00:00:00Z', last_sign_in_at: null, banned_until: null });
  await mirrorUser(pool, { id, email: 'changed@studify.test', created_at: '2026-10-01T00:00:00Z', last_sign_in_at: '2026-10-29T10:00:00Z', banned_until: '2030-01-01T00:00:00Z' });
  const row = await pool.query(`select email, to_json(created_at) #>> '{}' as created_at, last_sign_in_at is not null as signed_in, banned_until > now() as banned from auth.users where id = $1`, [id]);
  expect(row.rows).toEqual([{ email: 'changed@studify.test', created_at: '2026-10-01T00:00:00+00:00', signed_in: true, banned: true }]);
  await pool.query('delete from auth.users where id = $1', [id]);
});
