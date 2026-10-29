import { test } from 'bun:test';
// Turma-side handlers: quiz sharing (SOC-09, D-32), join-class (SOC-01.14), guardian-link (SP-03),
// Prova Provável generation (PRA-09.8) and schedule import (ING-07). Also the idempotent replay path.
import { assert, assertEquals, assertFalse } from './assert.ts';
import { handler as quizShare } from '../src/functions/quiz-share.ts';
import { handler as quizSharedOpen } from '../src/functions/quiz-shared-open.ts';
import { handler as joinClass } from '../src/functions/join-class.ts';
import { GUARDIAN_TOKEN_BYTES, handler as guardianLink } from '../src/functions/guardian-link.ts';
import { handler as provaProvavel } from '../src/functions/prova-provavel-generate.ts';
import { handler as scheduleImport } from '../src/functions/schedule-import.ts';
import { DEFAULT_PUBLIC_HOST, publicBaseUrl, sha256Hex, shareUrl } from '../src/shared-p2/util.ts';
import {
  ALICE,
  baseTables,
  BOB,
  CAROL,
  createFakeDb,
  createFakeDeps,
  type FakeEnv,
  GROUP,
  json,
  post,
  QIDS,
  type Row,
  SUBJECT,
  USERS,
} from './p2_fakes.ts';
import { uuidV7 } from '@studify/shared';

const T0 = new Date('2026-10-27T12:00:00Z');

function env(
  opts: {
    extra?: Record<string, Row[]>;
    baseUrl?: string | null;
    userRpc?: Parameters<typeof createFakeDeps>[0]['userRpc'];
    guardianMail?: Parameters<typeof createFakeDeps>[0]['guardianMail'];
    rpcs?: Record<string, (a: Row) => { data: unknown; error: { message: string } | null }>;
  } = {},
): FakeEnv {
  const tables = baseTables();
  for (const [k, v] of Object.entries(opts.extra ?? {})) tables[k] = [...(tables[k] ?? []), ...v];
  const db = createFakeDb({ tables, users: USERS, rpcs: opts.rpcs ?? {} });
  return createFakeDeps({ db, now: T0, baseUrl: opts.baseUrl, userRpc: opts.userRpc, guardianMail: opts.guardianMail });
}

const QUIZ = '00000000-0000-4000-8000-0000000071ab';

function sharedQuizTables(): Record<string, Row[]> {
  return {
    quizzes: [{
      id: QUIZ,
      owner_id: ALICE,
      subject_id: SUBJECT,
      class_group_id: GROUP,
      kind: 'practice',
      title: 'Simulado',
      question_ids: QIDS.slice(0, 5),
      deleted_at: null,
    }],
    quiz_attempts: [{
      id: '00000000-0000-4000-8000-0000000000a7',
      user_id: ALICE,
      quiz_id: QUIZ,
      status: 'submitted',
      finished_at: '2026-10-26T10:00:00Z',
    }],
    attempt_answers: [1, 2, 3, 4, 5].map((n) => ({
      id: `00000000-0000-4000-8000-0000000000${n}0`,
      attempt_id: '00000000-0000-4000-8000-0000000000a7',
      question_id: QIDS[n - 1],
      correct: n <= 3,
    })),
  };
}

test('quiz-share: 404 for a non-owner (IDOR), 400 before the owner finished the quiz', async () => {
  const e = env({ extra: sharedQuizTables() });
  const notOwner = await quizShare(post({ quiz_id: QUIZ }, { jwt: 'jwt-bob' }), e.deps);
  assertEquals(notOwner.status, 404);
  (e.db.tables.quiz_attempts![0] as Row).status = 'in_progress';
  const unfinished = await quizShare(post({ quiz_id: QUIZ }, { jwt: 'jwt-alice' }), e.deps);
  assertEquals(unfinished.status, 400);
});

test('quiz-share: the snapshot has no answer keys, explanations, rationales or page refs (SOC-09.2, D-32)', async () => {
  const e = env({ extra: sharedQuizTables() });
  const res = await quizShare(post({ quiz_id: QUIZ }, { jwt: 'jwt-alice' }), e.deps);
  assertEquals(res.status, 200);
  const body = await json(res);
  const row = e.db.tables.quiz_shares![0] as Row;
  const stored = JSON.stringify(row.snapshot);
  for (const forbidden of ['"correct"', 'explanation', 'rationale', 'source_pages', 'justification']) {
    assertFalse(stored.includes(forbidden), `snapshot contains ${forbidden}`);
  }
  assertEquals((row.snapshot as { questions: unknown[] }).questions.length, 5);
  assertEquals((body.token as string).length, 22);
  assertEquals(body.url, `https://studify.test/q/${body.token}`);
});

test('BASE_URL: unset defaults to studify.vendua.com.br (D-05); set overrides; empty keeps the custom scheme', () => {
  assertEquals(DEFAULT_PUBLIC_HOST, 'studify.vendua.com.br');
  assertEquals(publicBaseUrl(undefined), 'studify.vendua.com.br');
  assertEquals(publicBaseUrl('https://staging.example.test/'), 'staging.example.test');
  assertEquals(publicBaseUrl(''), null);
  assertEquals(shareUrl(publicBaseUrl(undefined), 'tok'), 'https://studify.vendua.com.br/q/tok');
  assertEquals(shareUrl(publicBaseUrl(''), 'tok'), 'studify://quiz/shared/tok');
});

test('quiz-share: without a BASE_URL the link is the studify:// route', async () => {
  const e = env({ extra: sharedQuizTables(), baseUrl: null });
  const body = await json(await quizShare(post({ quiz_id: QUIZ }, { jwt: 'jwt-alice' }), e.deps));
  assertEquals(body.url, `studify://quiz/shared/${body.token}`);
});

test('quiz-shared-open: outsider gets the questions and a fresh practice attempt, no subject name, creator score', async () => {
  const e = env({ extra: sharedQuizTables() });
  const share = await json(await quizShare(post({ quiz_id: QUIZ }, { jwt: 'jwt-alice' }), e.deps));
  const first = await quizSharedOpen(post({ token: share.token }, { jwt: 'jwt-carol' }), e.deps);
  assertEquals(first.status, 200);
  const body = await json(first);
  assertEquals(body.outsider, true);
  assertEquals(body.subject_name, null);
  assertEquals(body.question_count, 5);
  assertEquals(body.creator_score, { k: 3, n: 5 });
  assertEquals(body.title, 'Simulado');
  const practice = e.db.tables.quizzes!.find((q) => q.owner_id === CAROL) as Row;
  assertEquals(practice.kind, 'practice');
  assertEquals(practice.question_ids, QIDS.slice(0, 5));
  assertEquals(body.quiz_id, practice.id);
  const again = await json(await quizSharedOpen(post({ token: share.token }, { jwt: 'jwt-carol' }), e.deps));
  assertEquals(again.quiz_id, body.quiz_id, 'a repeat open reuses the quiz');
  assertEquals(again.attempt_id, body.attempt_id, 'and the open attempt');
  assertEquals(e.db.tables.quiz_shares![0]!.uses, 2);
});

test('quiz-shared-open: a Turma member sees the subject name and is not an outsider', async () => {
  const e = env({ extra: sharedQuizTables() });
  const share = await json(await quizShare(post({ quiz_id: QUIZ }, { jwt: 'jwt-alice' }), e.deps));
  const body = await json(await quizSharedOpen(post({ token: share.token }, { jwt: 'jwt-bob' }), e.deps));
  assertEquals(body.outsider, false);
  assertEquals(body.subject_name, 'Biologia');
});

test('quiz-shared-open: 404 for an expired or revoked token, 401 without a session', async () => {
  const e = env({ extra: sharedQuizTables() });
  const share = await json(await quizShare(post({ quiz_id: QUIZ }, { jwt: 'jwt-alice' }), e.deps));
  const row = e.db.tables.quiz_shares![0] as Row;
  row.revoked_at = T0.toISOString();
  assertEquals((await quizSharedOpen(post({ token: share.token }, { jwt: 'jwt-carol' }), e.deps)).status, 404);
  row.revoked_at = null;
  e.setNow(new Date(T0.getTime() + 31 * 24 * 3600 * 1000));
  assertEquals((await quizSharedOpen(post({ token: share.token }, { jwt: 'jwt-carol' }), e.deps)).status, 404);
  assertEquals((await quizSharedOpen(post({ token: share.token }), e.deps)).status, 401);
});

// ---- join-class (SOC-01.2, SOC-01.14) ----

test('join-class: normalizes the grouped code and returns the RPC payload unchanged', async () => {
  const calls: Record<string, unknown>[] = [];
  const e = env({
    userRpc: (jwt, fn, args) => {
      calls.push({ jwt, fn, args });
      return Promise.resolve({ data: { class_group_id: GROUP, status: 'pending' }, error: null });
    },
  });
  const res = await joinClass(post({ code: 'abcd-efgh' }, { jwt: 'jwt-bob' }), e.deps);
  assertEquals(res.status, 200);
  assertEquals(await json(res), { class_group_id: GROUP, status: 'pending' });
  assertEquals(calls[0]?.fn, 'join_class_group');
  assertEquals(calls[0]?.args, { p_code: 'ABCDEFGH' });
  assertEquals(calls[0]?.jwt, 'jwt-bob');
});

test('join-class: an invalid code is recorded with the service role so the 5/hour limit trips', async () => {
  const e = env({
    userRpc: () => Promise.resolve({ data: null, error: { message: 'invite_invalid' } }),
    rpcs: { record_join_failure: () => ({ data: null, error: null }) },
  });
  const res = await joinClass(post({ code: 'ABCDEFGH' }, { jwt: 'jwt-bob' }), e.deps);
  assertEquals(res.status, 422);
  assertEquals(((await json(res)).error as { code: string }).code, 'invite_invalid');
  const recorded = e.db.rpcCalls.find((c) => c.name === 'record_join_failure');
  assertEquals(recorded?.args, { p_user_id: BOB });
});

test('join-class: expired and used-up codes are recorded too; rate_limited is not recorded again', async () => {
  for (const code of ['invite_expired', 'invite_used_up']) {
    const e = env({
      userRpc: () => Promise.resolve({ data: null, error: { message: code } }),
      rpcs: { record_join_failure: () => ({ data: null, error: null }) },
    });
    const res = await joinClass(post({ code: 'ABCDEFGH' }, { jwt: 'jwt-bob' }), e.deps);
    assertEquals(((await json(res)).error as { code: string }).code, code);
    assertEquals(e.db.rpcCalls.filter((c) => c.name === 'record_join_failure').length, 1);
  }
  const limited = env({
    userRpc: () => Promise.resolve({ data: null, error: { message: 'rate_limited' } }),
    rpcs: { record_join_failure: () => ({ data: null, error: null }) },
  });
  const res = await joinClass(post({ code: 'ABCDEFGH' }, { jwt: 'jwt-bob' }), limited.deps);
  assertEquals(res.status, 429);
  assertEquals(limited.db.rpcCalls.filter((c) => c.name === 'record_join_failure').length, 0);
});

test('join-class: a malformed code (outside the safe alphabet) is an invite_invalid failure without calling the RPC', async () => {
  let called = false;
  const e = env({
    userRpc: () => {
      called = true;
      return Promise.resolve({ data: null, error: null });
    },
    rpcs: { record_join_failure: () => ({ data: null, error: null }) },
  });
  const res = await joinClass(post({ code: '0OIl0OIl' }, { jwt: 'jwt-bob' }), e.deps);
  assertEquals(res.status, 422);
  assertFalse(called);
  assertEquals(e.db.rpcCalls.filter((c) => c.name === 'record_join_failure').length, 1);
});

// ---- guardian-link (SP-03) ----

test('guardian-link: stores only a token hash, mails the raw token link, returns link id and status only', async () => {
  const mails: { guardianEmail: string; verifyUrl: string }[] = [];
  const e = env({ guardianMail: (args) => Promise.resolve(void mails.push(args)) });
  const res = await guardianLink(post({ guardian_email: 'Mae@Example.test' }, { jwt: 'jwt-alice' }), e.deps);
  assertEquals(res.status, 200);
  const body = await json(res);
  assertEquals(Object.keys(body).sort(), ['link_id', 'status']);
  assertEquals(body.status, 'pending');
  const row = e.db.tables.guardian_links![0] as Row;
  assertEquals(row.guardian_email, 'mae@example.test');
  assertEquals(mails.length, 1);
  const token = mails[0]!.verifyUrl.split('/guardian/')[1] as string;
  assert(token.length > 40 && token.length >= GUARDIAN_TOKEN_BYTES);
  assertEquals(row.verify_token_hash, await sha256Hex(token));
  assertFalse(JSON.stringify(row).includes(token));
});

test("guardian-link: 400 for the student's own e-mail and for a malformed address; a repeat call rotates the token", async () => {
  const e = env({ guardianMail: () => Promise.resolve() });
  assertEquals(
    (await guardianLink(post({ guardian_email: 'alice@example.test' }, { jwt: 'jwt-alice' }), e.deps)).status,
    400,
  );
  assertEquals((await guardianLink(post({ guardian_email: 'não é email' }, { jwt: 'jwt-alice' }), e.deps)).status, 400);
  const first = await json(
    await guardianLink(post({ guardian_email: 'mae@example.test' }, { jwt: 'jwt-alice' }), e.deps),
  );
  const hashBefore = (e.db.tables.guardian_links![0] as Row).verify_token_hash;
  const second = await json(
    await guardianLink(post({ guardian_email: 'mae@example.test' }, { jwt: 'jwt-alice' }), e.deps),
  );
  assertEquals(second.link_id, first.link_id);
  assert((e.db.tables.guardian_links![0] as Row).verify_token_hash !== hashBefore);
  assertEquals(e.db.tables.guardian_links!.length, 1);
});

// ---- prova provável (PRA-09.8) and schedule import (ING-07) ----

test('prova-provavel-generate: queues pp.generate for the owner; 404 for another student; regenerate limit', async () => {
  const EXAM = '00000000-0000-4000-8000-0000000000e1';
  const e = env({
    extra: {
      exams: [{ id: EXAM, user_id: ALICE, deleted_at: null }],
      quizzes: [] as Row[],
    },
  });
  const other = await provaProvavel(post({ exam_id: EXAM }, { jwt: 'jwt-bob' }), e.deps);
  assertEquals(other.status, 404);
  const first = await provaProvavel(post({ exam_id: EXAM }, { jwt: 'jwt-alice' }), e.deps);
  assertEquals(first.status, 202);
  assert(e.sent.some((s) => s.queue === 'pp.generate' && s.data.exam_id === EXAM && s.data.user_id === ALICE && (s.options as { startAfterSeconds?: number })?.startAfterSeconds === 0));
  (e.db.tables.quizzes as Row[]).push(
    ...[1, 2, 3].map((n) => ({ id: `q${n}`, owner_id: ALICE, kind: 'predicted_test', scope: { exam_id: EXAM } })),
  );
  const duplicate = await provaProvavel(post({ exam_id: EXAM }, { jwt: 'jwt-alice' }), e.deps);
  assertEquals(duplicate.status, 409);
  const regen = await provaProvavel(post({ exam_id: EXAM, regenerate: true }, { jwt: 'jwt-alice' }), e.deps);
  assertEquals(regen.status, 202);
  (e.db.tables.quizzes as Row[]).push({ id: 'q4', owner_id: ALICE, kind: 'predicted_test', scope: { exam_id: EXAM } });
  const over = await provaProvavel(post({ exam_id: EXAM, regenerate: true }, { jwt: 'jwt-alice' }), e.deps);
  assertEquals(over.status, 429);
  assertEquals(((await json(over)).error as { code: string }).code, 'regenerate_limit');
});

test('schedule-import: 202 with ids and schedule.import queued; 404 for a document the student did not upload; replay does not requeue', async () => {
  const DOC = '00000000-0000-4000-8000-0000000000d1';
  const e = env({
    extra: { documents: [{ id: DOC, subject_id: SUBJECT, uploaded_by: ALICE, deleted_at: null }] },
  });
  const key = uuidV7();
  const res = await scheduleImport(post({ document_id: DOC }, { jwt: 'jwt-alice', key }), e.deps);
  assertEquals(res.status, 202);
  const body = await json(res);
  assert(typeof body.schedule_import_id === 'string');
  assertEquals(e.sent.filter((s) => s.queue === 'schedule.import').length, 1);
  const replay = await scheduleImport(post({ document_id: DOC }, { jwt: 'jwt-alice', key }), e.deps);
  assertEquals(replay.status, 202);
  assertEquals(replay.headers.get('idempotent-replayed'), 'true');
  assertEquals(e.sent.filter((s) => s.queue === 'schedule.import').length, 1, 'a replay never queues twice');
  const bob = await scheduleImport(post({ document_id: DOC }, { jwt: 'jwt-bob' }), e.deps);
  assertEquals(bob.status, 404);
});
