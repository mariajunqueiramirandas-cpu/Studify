import { afterAll, beforeAll, expect, test } from 'bun:test';
// Every data endpoint (src/data) against the real, migrated schema (RUNTIME_TEST_DATABASE_URL), as a seeded student,
// with the example input the route declares. A read must answer `done`; a write may refuse with a client error
// (forbidden, not_found, invalid_request, ...), never with internal_error, which is what a misspelled table or
// column, a wrong type or a missing grant turns into. Each route also answers over SSE.
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createDb, type DbAuth } from '@studify/db';
import { createApp } from '../src/app.ts';
import { DATA_ROUTES } from '../src/data/index.ts';
import type { DataSeed } from '../src/data/define.ts';
import type { P2Deps } from '../src/shared-p2/deps.ts';
import { createFakeDb, createFakeDeps } from './p2_fakes.ts';

const url = process.env.RUNTIME_TEST_DATABASE_URL;
const maybe = url ? test : test.skip;

let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let seed: DataSeed;
const TOKEN = 'token-data-routes';

beforeAll(async () => {
  if (!url) return;
  pool = new pg.Pool({ connectionString: url, max: 8 });
  const id = () => crypto.randomUUID();
  seed = { userId: id(), subjectId: id(), documentId: id(), nodeId: id(), classGroupId: id(), goalId: id(), examId: id(), missingId: id() };
  const unit = id();
  const s = seed;
  await pool.query(`insert into auth.users (id, email) values ($1, $2)`, [s.userId, `data-${s.userId}@studify.test`]);
  await pool.query(
    `insert into public.profiles (id, display_name, display_name_status, birth_year, birth_month, privacy_notice_version, privacy_accepted_at)
     values ($1, 'Dara', 'approved', 2009, 1, 'v1', now())`,
    [s.userId],
  );
  await pool.query(`insert into public.subjects (id, owner_profile_id, created_by, name, color, icon) values ($1, $2, $2, 'Física', '#0000aa', 'atom')`, [s.subjectId, s.userId]);
  await pool.query(
    `insert into public.documents (id, subject_id, uploaded_by, title, kind, storage_path, size_bytes, checksum_sha256, status)
     values ($1, $2, $3, 'Apostila', 'textbook', $4, 10, $5, 'ready')`,
    [s.documentId, s.subjectId, s.userId, `${s.subjectId}/${s.documentId}.pdf`, 'c'.repeat(64)],
  );
  await pool.query(`insert into public.knowledge_nodes (id, subject_id, kind, title) values ($1, $2, 'unit', 'Mecânica')`, [unit, s.subjectId]);
  await pool.query(`insert into public.knowledge_nodes (id, subject_id, parent_id, kind, title) values ($1, $2, $3, 'topic', 'Cinemática')`, [s.nodeId, s.subjectId, unit]);
  await pool.query(`insert into public.class_groups (id, name, owner_id) values ($1, 'Turma A', $2)`, [s.classGroupId, s.userId]);
  await pool.query(`insert into public.class_group_members (class_group_id, user_id, role, status) values ($1, $2, 'owner', 'active')`, [s.classGroupId, s.userId]);
  await pool.query(`insert into public.goals (id, user_id, mode, name, start_date, end_date) values ($1, $2, 'exam_week', 'Provas', current_date, current_date + 14)`, [s.goalId, s.userId]);
  await pool.query(`insert into public.exams (id, goal_id, user_id, subject_id, title, local_date) values ($1, $2, $3, $4, 'Prova de Física', current_date + 7)`, [s.examId, s.goalId, s.userId, s.subjectId]);

  const auth = {
    getUser: async (jwt: string) =>
      jwt === TOKEN ? { data: { user: { id: s.userId, email: `data-${s.userId}@studify.test` } }, error: null } : { data: { user: null }, error: { message: 'invalid' } },
    admin: {},
  } as unknown as DbAuth;
  const db = createDb({ pool, auth });
  const fake = createFakeDeps({ db: createFakeDb() });
  const deps: P2Deps = { ...fake.deps, db, asUser: (user) => db.asUser({ sub: user.userId, role: 'authenticated', email: user.email }), newId: () => crypto.randomUUID() };
  app = createApp(deps, path.join(tmpdir(), 'no-site'));
});

afterAll(async () => {
  if (!url) return;
  await pool.query('delete from public.class_groups where id = $1', [seed.classGroupId]).catch(() => undefined);
  await pool.query('delete from auth.users where id = $1', [seed.userId]);
  await pool.end();
});

async function call(name: string, input: unknown, write: boolean): Promise<{ event: string; data: any }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (write) headers['Idempotency-Key'] = '0190b000-0000-7000-8000-' + crypto.randomUUID().slice(-12);
  const res = await app.request(`/api/${name}`, { method: 'POST', headers, body: JSON.stringify(input) });
  if (!(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    return { event: 'http', data: { status: res.status, body: await res.text() } };
  }
  const frames = (await res.text()).split('\n\n');
  for (const frame of frames) {
    const event = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    if (event === 'done' || event === 'error') return { event, data: JSON.parse(data ?? 'null') };
  }
  return { event: 'none', data: frames };
}

maybe('every data route answers its example over SSE, with no database error', async () => {
  const failures: string[] = [];
  // DATA_ROUTES_ONLY=goals-,calendar- checks only the routes with those name prefixes (while porting a feature).
  const only = (process.env.DATA_ROUTES_ONLY ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const chosen = only.length === 0 ? DATA_ROUTES : DATA_ROUTES.filter((r) => only.some((p) => r.name.startsWith(p)));
  const reads = chosen.filter((r) => !r.write);
  const writes = chosen.filter((r) => r.write);
  for (const route of [...reads, ...writes]) {
    const out = await call(route.name, route.example(seed), route.write);
    if (out.event === 'done') continue;
    if (out.event === 'error' && route.write && out.data?.code !== 'internal_error') continue;
    failures.push(`${route.name}: ${JSON.stringify(out.data)}`);
  }
  expect(failures).toEqual([]);
  expect(DATA_ROUTES.length).toBeGreaterThan(0);
});
