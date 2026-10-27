// Duel handlers (SOC-02): auth, validation, membership, blocks, answer-key secrecy, server timing with the
// 1.5 s grace, IDOR, and a full finished duel with winner, mistakes and pushes.
import { assert, assertEquals, assertFalse } from '@std/assert';
import { handler as duelCreate } from '../duel-create/index.ts';
import { handler as duelRespond } from '../duel-respond/index.ts';
import { handler as duelNext } from '../duel-next/index.ts';
import { handler as duelAnswer } from '../duel-answer/index.ts';
import {
  ALICE,
  baseTables,
  BOB,
  createFakeDb,
  createFakeDeps,
  type FakeEnv,
  GROUP,
  json,
  post,
  SUBJECT,
  USERS,
} from './p2_fakes.ts';
import { uuidV7 } from '@studify/shared';

const T0 = new Date('2026-10-27T12:00:00Z');
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

function env(extra: Record<string, unknown[]> = {}): FakeEnv {
  const tables = baseTables();
  for (const [k, v] of Object.entries(extra)) tables[k] = [...(tables[k] ?? []), ...(v as Record<string, unknown>[])];
  return createFakeDeps({ db: createFakeDb({ tables, users: USERS }), now: T0 });
}

async function createDuel(e: FakeEnv, length = 5): Promise<{ duel_id: string; quiz_id: string; attempt_id: string }> {
  const res = await duelCreate(
    post({ class_group_id: GROUP, opponent_id: BOB, subject_id: SUBJECT, length }, { jwt: 'jwt-alice' }),
    e.deps,
  );
  assertEquals(res.status, 200, await res.clone().text());
  return (await json(res)) as unknown as { duel_id: string; quiz_id: string; attempt_id: string };
}

async function acceptDuel(e: FakeEnv, duelId: string): Promise<string> {
  const res = await duelRespond(post({ duel_id: duelId, accept: true }, { jwt: 'jwt-bob' }), e.deps);
  assertEquals(res.status, 200);
  return (await json(res)).attempt_id as string;
}

async function next(e: FakeEnv, jwt: string, attemptId: string): Promise<Record<string, unknown>> {
  const res = await duelNext(post({ attempt_id: attemptId }, { jwt }), e.deps);
  assertEquals(res.status, 200, await res.clone().text());
  return json(res);
}

async function answer(e: FakeEnv, jwt: string, attemptId: string, questionId: string, choice: string) {
  const res = await duelAnswer(
    post({ attempt_id: attemptId, question_id: questionId, response: { choice }, answer_id: uuidV7() }, { jwt }),
    e.deps,
  );
  return res;
}

Deno.test('duel-create: 401 without a session (auth before anything else)', async () => {
  const e = env();
  const res = await duelCreate(
    post({ class_group_id: GROUP, opponent_id: BOB, subject_id: SUBJECT, length: 5 }),
    e.deps,
  );
  assertEquals(res.status, 401);
  assertEquals(((await json(res)).error as { code: string }).code, 'forbidden');
});

Deno.test('duel-create: 400 for a length outside 5 / 7 / 10 and for a missing Idempotency-Key', async () => {
  const e = env();
  const bad = await duelCreate(
    post({ class_group_id: GROUP, opponent_id: BOB, subject_id: SUBJECT, length: 6 }, { jwt: 'jwt-alice' }),
    e.deps,
  );
  assertEquals(bad.status, 400);
  assertEquals(((await json(bad)).error as { code: string }).code, 'invalid_request');
  const noKey = await duelCreate(
    post({ class_group_id: GROUP, opponent_id: BOB, subject_id: SUBJECT, length: 5 }, { jwt: 'jwt-alice', key: null }),
    e.deps,
  );
  assertEquals(noKey.status, 400);
});

Deno.test('duel-create: 403 not_member when the caller is outside the Turma', async () => {
  const e = env();
  const res = await duelCreate(
    post({ class_group_id: GROUP, opponent_id: BOB, subject_id: SUBJECT, length: 5 }, { jwt: 'jwt-carol' }),
    e.deps,
  );
  assertEquals(res.status, 403);
  assertEquals(((await json(res)).error as { code: string }).code, 'not_member');
});

Deno.test('duel-create: 403 blocked when either player blocked the other (SOC-02.11)', async () => {
  const e = env({ user_blocks: [{ blocker_id: BOB, blocked_id: ALICE }] });
  const res = await duelCreate(
    post({ class_group_id: GROUP, opponent_id: BOB, subject_id: SUBJECT, length: 5 }, { jwt: 'jwt-alice' }),
    e.deps,
  );
  assertEquals(res.status, 403);
  assertEquals(((await json(res)).error as { code: string }).code, 'blocked');
});

Deno.test('duel-create: creates quiz, duel, challenger attempt, expiry job and the opponent push', async () => {
  const e = env();
  const created = await createDuel(e);
  const duel = e.db.tables.duels?.[0] as Record<string, unknown>;
  assertEquals(duel.status, 'waiting_opponent');
  assertEquals(duel.challenger_attempt_id, created.attempt_id);
  const quiz = e.db.tables.quizzes?.[0] as { kind: string; question_ids: string[] };
  assertEquals(quiz.kind, 'duel');
  assertEquals(quiz.question_ids.length, 5);
  assert(e.sent.some((s) => s.queue === 'duel.expire' && s.options?.startAfterSeconds === 48 * 3600));
  const push = e.sent.find((s) => s.queue === 'notify.dispatch');
  assertEquals(push?.data.user_id, BOB);
  assertEquals(push?.data.type, 'duel_challenge');
  assertEquals((push?.data.data as { body: string }).body, 'Ana te desafiou num duelo de Biologia!');
});

Deno.test('duel-next never sends the answer key, rationales or explanation', async () => {
  const e = env();
  const created = await createDuel(e);
  const q = await next(e, 'jwt-alice', created.attempt_id);
  const text = JSON.stringify(q);
  assertFalse(text.includes('"correct"'));
  assertFalse(text.includes('rationale'));
  assertFalse(text.includes('explanation'));
  assertFalse(text.includes('source_pages'));
  assertEquals(q.index, 0);
  assertEquals(q.deadline_at, at(30).toISOString());
});

Deno.test('duel-next: a repeated call returns the same served question without resetting the timer', async () => {
  const e = env();
  const created = await createDuel(e);
  const first = await next(e, 'jwt-alice', created.attempt_id);
  e.setNow(at(10));
  const again = await next(e, 'jwt-alice', created.attempt_id);
  assertEquals((again.question as { id: string }).id, (first.question as { id: string }).id);
  assertEquals(again.deadline_at, first.deadline_at);
  assertEquals(e.db.tables.question_served?.length, 1);
});

Deno.test('duel-answer: an answer 2 s after serving is correct and scores 100 + time bonus', async () => {
  const e = env();
  const created = await createDuel(e);
  await acceptDuel(e, created.duel_id);
  const q = await next(e, 'jwt-alice', created.attempt_id);
  const qid = (q.question as { id: string }).id;
  e.setNow(at(2));
  const res = await answer(e, 'jwt-alice', created.attempt_id, qid, 'b');
  assertEquals(res.status, 200);
  const body = await json(res);
  assertEquals(body.correct, true);
  // t = 2 − 0.5 = 1.5 s of 30 s: 100 + round(50 × 0.95) = 148.
  assertEquals(body.points, 148);
  assertEquals(body.correct_response, { choice: 'b' });
});

Deno.test('duel-answer: a receipt after deadline + 1.5 s scores 0 (late answer)', async () => {
  const e = env();
  const created = await createDuel(e);
  await acceptDuel(e, created.duel_id);
  const q = await next(e, 'jwt-alice', created.attempt_id);
  const qid = (q.question as { id: string }).id;
  e.setNow(at(31.6)); // deadline at 30 s, grace 1.5 s: 31.6 s is past the grace.
  const body = await json(await answer(e, 'jwt-alice', created.attempt_id, qid, 'b'));
  assertEquals(body.correct, false);
  assertEquals(body.points, 0);
});

Deno.test('duel-answer: a receipt inside the 1.5 s grace after the deadline is still scored', async () => {
  const e = env();
  const created = await createDuel(e);
  await acceptDuel(e, created.duel_id);
  const q = await next(e, 'jwt-alice', created.attempt_id);
  const qid = (q.question as { id: string }).id;
  e.setNow(at(31));
  const body = await json(await answer(e, 'jwt-alice', created.attempt_id, qid, 'b'));
  assertEquals(body.correct, true);
  assert((body.points as number) > 0);
});

Deno.test("duel-answer and duel-next: 404 for another player's attempt (IDOR)", async () => {
  const e = env();
  const created = await createDuel(e);
  await acceptDuel(e, created.duel_id);
  const nextRes = await duelNext(post({ attempt_id: created.attempt_id }, { jwt: 'jwt-bob' }), e.deps);
  assertEquals(nextRes.status, 404);
  const ansRes = await answer(e, 'jwt-bob', created.attempt_id, '00000000-0000-4000-8000-0000000000ff', 'a');
  assertEquals(ansRes.status, 404);
});

Deno.test('duel-answer: 400 for a question that was never served to this player', async () => {
  const e = env();
  const created = await createDuel(e);
  const q = await next(e, 'jwt-alice', created.attempt_id);
  const other = (e.db.tables.quizzes?.[0] as { question_ids: string[] }).question_ids.find((id) =>
    id !== (q.question as { id: string }).id
  ) as string;
  const res = await answer(e, 'jwt-alice', created.attempt_id, other, 'b');
  assertEquals(res.status, 400);
});

Deno.test('duel-respond: 403 for the challenger, decline leaves no attempt', async () => {
  const e = env();
  const created = await createDuel(e);
  const mine = await duelRespond(post({ duel_id: created.duel_id, accept: true }, { jwt: 'jwt-alice' }), e.deps);
  assertEquals(mine.status, 403);
  const declined = await duelRespond(post({ duel_id: created.duel_id, accept: false }, { jwt: 'jwt-bob' }), e.deps);
  assertEquals(declined.status, 200);
  assertEquals((await json(declined)).status, 'declined');
  assertEquals((e.db.tables.duels?.[0] as { status: string }).status, 'declined');
});

Deno.test('a full duel: winner by points, mistakes for wrong answers, evidence and result pushes', async () => {
  const e = env();
  const created = await createDuel(e, 5);
  const bobAttempt = await acceptDuel(e, created.duel_id);
  for (let i = 0; i < 5; i++) {
    e.setNow(at(i * 40));
    const aq = await next(e, 'jwt-alice', created.attempt_id);
    const bq = await next(e, 'jwt-bob', bobAttempt);
    const aid = (aq.question as { id: string }).id;
    const bid = (bq.question as { id: string }).id;
    assertEquals(aid, bid);
    assertEquals((await json(await answer(e, 'jwt-alice', created.attempt_id, aid, 'b'))).correct, true);
    assertEquals((await json(await answer(e, 'jwt-bob', bobAttempt, bid, 'a'))).correct, false);
  }
  const duel = e.db.tables.duels?.[0] as {
    status: string;
    winner_id: string;
    challenger_score: number;
    opponent_score: number;
  };
  assertEquals(duel.status, 'finished');
  assertEquals(duel.winner_id, ALICE);
  assert(duel.challenger_score > duel.opponent_score);
  assertEquals(e.db.tables.mistakes?.length, 5);
  assertEquals(e.db.tables.mastery_evidence?.filter((r) => r.source === 'duel').length, 10);
  assert(e.sent.filter((s) => s.queue === 'notify.dispatch' && s.data.type === 'duel_finished').length === 2);
  const finished = e.db.tables.quiz_attempts?.filter((r) => r.status === 'submitted');
  assertEquals(finished?.length, 2);
});

Deno.test('a full duel with equal totals is a tie with winner_id null (SOC-02.6)', async () => {
  const e = env();
  const created = await createDuel(e, 5);
  const bobAttempt = await acceptDuel(e, created.duel_id);
  for (let i = 0; i < 5; i++) {
    e.setNow(at(i * 40));
    const aid = ((await next(e, 'jwt-alice', created.attempt_id)).question as { id: string }).id;
    const bid = ((await next(e, 'jwt-bob', bobAttempt)).question as { id: string }).id;
    await answer(e, 'jwt-alice', created.attempt_id, aid, 'a');
    await answer(e, 'jwt-bob', bobAttempt, bid, 'a');
  }
  const duel = e.db.tables.duels?.[0] as { status: string; winner_id: unknown };
  assertEquals(duel.status, 'finished');
  assertEquals(duel.winner_id, null);
});
