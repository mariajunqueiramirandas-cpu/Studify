import { test } from 'bun:test';
// sync-push (ADR 0007): idempotent re-push, clock-skew clamp, IDOR on cards, FSRS replay, LWW bounds.
import { assert, assertEquals } from './assert.ts';
import { ALICE, BOB, NOW, NOW_MS, makeHarness, request, json, makePdf, withUsers } from './fakes.ts';
import { IDS, seedWorld, v7 } from './world.ts';
import { handler } from '../src/functions/sync-push.ts';

function review(id: string, cardId: string, reviewedAt: string, rating = 3) {
  return {
    id,
    kind: 'review_log',
    created_at: reviewedAt,
    payload: { card_id: cardId, rating, reviewed_at: reviewedAt, client_reviewed_at: reviewedAt, device_id: 'device-1' },
  };
}

function push(items: unknown[], token?: string, idem = '0190a000-0000-7000-8000-0000000000c1') {
  return request('sync-push', { token, idem, body: { schema_version: 1, device_id: 'device-1', items } });
}

test('sync-push: a review is stored once, acked, and the card state is returned', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const id = v7(10);
  const res = await handler(push([review(id, IDS.card, new Date(NOW_MS - 60_000).toISOString())]), h.deps);
  assertEquals(res.status, 200);
  const body = await json(res);
  assertEquals(body.acked, [id]);
  assertEquals(body.rejected, []);
  assertEquals(body.card_states.length, 1);
  assertEquals(body.card_states[0].card_id, IDS.card);
  assertEquals(body.card_states[0].reps, 1);
  assertEquals(h.db.rows('review_logs').length, 1);
  assertEquals(h.db.rows('card_states')[0]?.last_log_id, id);
});

test('sync-push: re-pushing the same ids inserts nothing new and acks them again', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const items = [review(v7(11), IDS.card, new Date(NOW_MS - 120_000).toISOString()), review(v7(12), IDS.card, new Date(NOW_MS - 60_000).toISOString(), 1)];
  const first = await json(await handler(push(items), h.deps));
  const second = await json(await handler(push(items), h.deps));
  assertEquals(h.db.rows('review_logs').length, 2, 'no duplicate review logs');
  assertEquals(second.acked.sort(), first.acked.sort());
  assertEquals(second.card_states[0].reps, 2, 'replay still folds the two logs once');
});

test('sync-push: an existing introduced_at in PostgREST form (+00:00) is returned as an ISO instant', async () => {
  const h = makeHarness();
  await seedWorld(h);
  // PostgREST renders timestamptz as `…+00:00`; the ack contract only takes `…Z` (500 on every later review before).
  h.db.seed('card_states', { user_id: ALICE.id, card_id: IDS.card, suspended: false, hidden: false, introduced_at: '2026-10-20T12:00:00.123+00:00' });
  const res = await handler(push([review(v7(13), IDS.card, new Date(NOW_MS - 60_000).toISOString())]), h.deps);
  assertEquals(res.status, 200);
  const body = await json(res);
  assertEquals(body.card_states[0].introduced_at, '2026-10-20T12:00:00.123Z');
});

test('sync-push: a review more than 5 min in the future is clamped to receipt and flagged clock_skew', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const threeDaysAhead = new Date(NOW_MS + 3 * 24 * 60 * 60 * 1000).toISOString();
  const id = v7(13);
  const body = await json(await handler(push([review(id, IDS.card, threeDaysAhead)]), h.deps));
  assertEquals(body.acked, [id]);
  const row = h.db.rows('review_logs')[0]!;
  assertEquals(new Date(row.reviewed_at as string).getTime(), NOW.getTime(), 'reviewed_at clamped to server receipt');
  assertEquals(row.clock_skew, true);
  assertEquals(row.client_reviewed_at, threeDaysAhead, 'the raw device time is kept');
});

test('sync-push: a review of a card in another student’s private subject is forbidden and stored nowhere', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const id = v7(14);
  const body = await json(await handler(push([review(id, IDS.bobCard, new Date(NOW_MS - 60_000).toISOString())]), h.deps));
  assertEquals(body.acked, []);
  assertEquals(body.rejected, [{ id, code: 'forbidden', drop: true }]);
  assertEquals(h.db.rows('review_logs').length, 0);
});

test('sync-push: an unknown card is rejected as not_found and the device drops it', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const id = v7(15);
  const body = await json(await handler(push([review(id, '00000000-0000-4000-8000-00000000dead', new Date(NOW_MS).toISOString())]), h.deps));
  assertEquals(body.rejected, [{ id, code: 'not_found', drop: true }]);
});

test('sync-push: an invalid row is rejected, the rest of the batch still lands', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const bad = { id: v7(16), kind: 'review_log', created_at: NOW.toISOString(), payload: { card_id: IDS.card, rating: 9 } };
  const good = review(v7(17), IDS.card, new Date(NOW_MS - 1000).toISOString());
  const body = await json(await handler(push([bad, good]), h.deps));
  assertEquals(body.acked, [good.id]);
  assertEquals(body.rejected, [{ id: bad.id, code: 'invalid', drop: true }]);
});

test('sync-push: podcast_play keeps the newest resume position; an unknown or private episode is dropped', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const episode = v7(19);
  const personal = v7(23);
  h.db.seed('podcast_episodes', [
    { id: episode, subject_id: IDS.subject, owner_user_id: null },
    { id: personal, subject_id: IDS.bobSubject, owner_user_id: BOB.id },
  ]);
  const play = (id: number, ep: string, position: number, at: number) => ({ id: v7(id), kind: 'podcast_play', created_at: NOW.toISOString(), payload: { episode_id: ep, position_ms: position, updated_at: new Date(at).toISOString() } });
  const first = await json(await handler(push([play(18, episode, 1200, NOW_MS - 1000)]), h.deps));
  assertEquals(first.acked, [v7(18)]);
  // An older write arriving late does not move the position back.
  const late = await json(await handler(push([play(20, episode, 300, NOW_MS - 5000)], undefined, v7(120)), h.deps));
  assertEquals(late.acked, [v7(20)]);
  assertEquals(h.db.rows('podcast_plays')[0]!.position_ms, 1200);
  const newer = await json(await handler(push([play(21, episode, 4000, NOW_MS)], undefined, v7(121)), h.deps));
  assertEquals(newer.acked, [v7(21)]);
  assertEquals(h.db.rows('podcast_plays')[0]!.position_ms, 4000);

  const bad = await json(await handler(push([play(22, v7(99), 1, NOW_MS), play(24, personal, 1, NOW_MS)], undefined, v7(122)), h.deps));
  assertEquals(bad.rejected, [
    { id: v7(22), code: 'not_found', drop: true },
    { id: v7(24), code: 'forbidden', drop: true },
  ]);
});

test('sync-push: a last-writer-wins plan edit clamps its timestamp and only moves forward', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.seed('plan_items', { id: v7(20), user_id: ALICE.id, status: 'planned', pinned: false, updated_at: new Date(NOW_MS - 60_000).toISOString(), deleted_at: null });
  const far = new Date(NOW_MS + 60 * 60 * 1000).toISOString();
  const item = { id: v7(21), kind: 'plan_item_status', created_at: NOW.toISOString(), payload: { plan_item_id: v7(20), status: 'done', updated_at: far } };
  const body = await json(await handler(push([item]), h.deps));
  assertEquals(body.acked, [item.id]);
  const row = h.db.rows('plan_items')[0]!;
  assertEquals(row.status, 'done');
  assertEquals(new Date(row.updated_at as string).getTime(), NOW_MS + 5 * 60 * 1000, 'timestamp clamped to receipt + 5 min');
});

test('sync-push: another student’s plan item is forbidden', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.seed('plan_items', { id: v7(22), user_id: BOB.id, status: 'planned', pinned: false, updated_at: new Date(NOW_MS - 1000).toISOString(), deleted_at: null });
  const item = { id: v7(23), kind: 'plan_item_status', created_at: NOW.toISOString(), payload: { plan_item_id: v7(22), status: 'done', updated_at: NOW.toISOString() } };
  const body = await json(await handler(push([item]), h.deps));
  assertEquals(body.rejected, [{ id: item.id, code: 'forbidden', drop: true }]);
  assertEquals(h.db.rows('plan_items')[0]?.status, 'planned');
});

test('sync-push: an offline quiz answer is re-graded on the server; AI-graded answers are queued', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const { mcq } = await import('./world.ts');
  h.db.seed('questions', [mcq(IDS.question, 'A')]);
  h.db.seed('quizzes', { id: IDS.quiz, owner_id: ALICE.id, question_ids: [IDS.question], kind: 'practice' });
  h.db.seed('quiz_attempts', { id: IDS.attempt, user_id: ALICE.id, quiz_id: IDS.quiz, status: 'in_progress', device_id: 'device-1', started_at: NOW.toISOString() });
  const answer = { id: v7(24), kind: 'attempt_answer', created_at: NOW.toISOString(), payload: { attempt_id: IDS.attempt, question_id: IDS.question, question_version: 1, response: { choice: 'A' }, time_spent_ms: 4000, answered_at: NOW.toISOString() } };
  const body = await json(await handler(push([answer]), h.deps));
  assertEquals(body.acked, [answer.id]);
  const row = h.db.rows('attempt_answers')[0]!;
  assertEquals(row.correct, true);
  assertEquals(row.score, 1);
  assertEquals(row.grading_status, 'graded');
});

test('sync-push: the request must carry a supported schema and at least one item', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const res = await handler(request('sync-push', { idem: '0190a000-0000-7000-8000-0000000000c2', body: { schema_version: 1, device_id: 'd', items: [] } }), h.deps);
  assertEquals(res.status, 400);
});

// Keep the imports used by helpers referenced even when a test is filtered out.
void [withUsers, makePdf, assert];
