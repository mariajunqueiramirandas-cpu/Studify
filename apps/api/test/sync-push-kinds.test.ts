import { test } from 'bun:test';
// sync-push, one outbox kind per test (api §4.1): each kind lands in its own table, is idempotent on its
// client id, refuses another student's rows, and keeps or drops a refused row as the contract says.
import { assertEquals } from './assert.ts';
import { ALICE, BOB, NOW, NOW_MS, makeHarness, request, json, type Harness } from './fakes.ts';
import { IDS, seedWorld, v7 } from './world.ts';
import { handler } from '../src/functions/sync-push.ts';

let pushNo = 0;
/** One push request. Each call uses a fresh idempotency key so the handler really runs again. */
function push(items: unknown[]) {
  pushNo += 1;
  return request('sync-push', { idem: v7(5000 + pushNo), body: { schema_version: 1, device_id: 'device-1', items } });
}

async function run(h: Harness, items: unknown[]) {
  return json(await handler(push(items), h.deps));
}

const AT = new Date(NOW_MS - 60_000).toISOString();

test('sync-push flag: a note the student can read is flagged once, queued for triage, and a replay is acked', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.seed('notes', { id: IDS.note, subject_id: IDS.subject, node_id: IDS.topic, deleted_at: null, version: 2 });
  const flag = { id: v7(30), kind: 'flag', created_at: AT, payload: { item_type: 'note', item_id: IDS.note, item_version: 2, reason: 'wrong_fact', comment: 'data errada' } };
  const first = await run(h, [flag]);
  assertEquals(first.acked, [flag.id]);
  const second = await run(h, [flag]);
  assertEquals(second.acked, [flag.id]);
  const rows = h.db.rows('content_flags');
  assertEquals(rows.length, 1, 'one open flag per (item, reporter)');
  assertEquals(rows[0]?.reporter_id, ALICE.id);
  assertEquals(rows[0]?.item_version, 2);
  assertEquals(rows[0]?.status, 'open');
  assertEquals(rows[0]?.class_group_id, null);
  assertEquals(h.enqueued.filter((e) => e.queue === 'flag.triage').length, 1);
  assertEquals(h.enqueued.find((e) => e.queue === 'flag.triage')?.options?.startAfterSeconds, 0);
});

test('sync-push flag: an item in another student’s private subject is not found and nothing is stored', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const flag = { id: v7(31), kind: 'flag', created_at: AT, payload: { item_type: 'card', item_id: IDS.bobCard, item_version: 1, reason: 'unclear' } };
  const body = await run(h, [flag]);
  assertEquals(body.rejected, [{ id: flag.id, code: 'not_found', drop: true }]);
  assertEquals(h.db.rows('content_flags').length, 0);
});

test('sync-push xp_event: the amount is clamped to the spec cap, zero is acked and not stored, a repeat is awarded once', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const base = { source_feature: 'MOT-01', ref_type: 'quiz', ref_id: IDS.attempt, occurred_at: AT, local_date: '2026-10-27', in_quiet_hours: false };
  const big = { id: v7(32), kind: 'xp_event', created_at: AT, payload: { ...base, amount: 500 } };
  const zero = { id: v7(33), kind: 'xp_event', created_at: AT, payload: { ...base, ref_id: IDS.card, amount: 0 } };
  const repeat = { id: v7(34), kind: 'xp_event', created_at: AT, payload: { ...base, amount: 5 } };
  const body = await run(h, [big, zero]);
  assertEquals(body.acked.sort(), [big.id, zero.id].sort());
  assertEquals(h.db.rows('xp_events').length, 1, 'a zero amount stores nothing');
  assertEquals(h.db.rows('xp_events')[0]?.amount, 50, 'clamped to XP_MAX_PER_EVENT');
  assertEquals(h.db.rows('xp_events')[0]?.user_id, ALICE.id);

  const again = await run(h, [repeat]);
  assertEquals(again.acked, [repeat.id], 'same (user, ref, feature) is acked, not awarded again');
  assertEquals(h.db.rows('xp_events').length, 1);
});

test('sync-push xp_event: an unknown ref_type longer than the column is invalid and dropped', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const xp = { id: v7(35), kind: 'xp_event', created_at: AT, payload: { amount: 5, source_feature: 'MOT-01', ref_type: 'x'.repeat(41), ref_id: IDS.card, occurred_at: AT, local_date: '2026-10-27', in_quiet_hours: false } };
  const body = await run(h, [xp]);
  assertEquals(body.rejected, [{ id: xp.id, code: 'invalid', drop: true }]);
});

test('sync-push study_session: stored with its activities; plan links the student does not own are dropped', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.seed('plan_items', { id: v7(36), user_id: BOB.id, status: 'planned', updated_at: AT, deleted_at: null });
  const session = {
    id: v7(37),
    kind: 'study_session',
    created_at: AT,
    payload: {
      kind: 'mixed',
      plan_item_id: v7(36),
      started_at: AT,
      ended_at: NOW.toISOString(),
      active_minutes: 12,
      activities: [{ type: 'review', count: 3 }],
    },
  };
  const body = await run(h, [session]);
  assertEquals(body.acked, [session.id]);
  const row = h.db.rows('study_sessions')[0]!;
  assertEquals(row.user_id, ALICE.id);
  assertEquals(row.kind, 'mixed');
  assertEquals(row.plan_item_id, null, 'another student’s plan item is not linked');
  assertEquals(row.active_minutes, 12);
  assertEquals(row.activities, [{ type: 'review', count: 3 }]);
});

test('sync-push study_session: another student’s session id is forbidden', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.seed('study_sessions', { id: v7(38), user_id: BOB.id, kind: 'mixed', started_at: AT, activities: [] });
  const session = { id: v7(38), kind: 'study_session', created_at: AT, payload: { kind: 'review', started_at: AT, active_minutes: 1 } };
  const body = await run(h, [session]);
  assertEquals(body.rejected, [{ id: session.id, code: 'forbidden', drop: true }]);
  assertEquals(h.db.rows('study_sessions')[0]?.user_id, BOB.id);
});

test('sync-push topic_read: a readable topic is stored; another student’s topic is forbidden; an unknown one not found', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const ok = { id: v7(39), kind: 'topic_read', created_at: AT, payload: { node_id: IDS.topic, depth: 'study', read_at: AT, seconds: 42 } };
  const theirs = { id: v7(40), kind: 'topic_read', created_at: AT, payload: { node_id: IDS.bobTopic, depth: 'study', read_at: AT, seconds: 5 } };
  const missing = { id: v7(41), kind: 'topic_read', created_at: AT, payload: { node_id: '00000000-0000-4000-8000-00000000dead', depth: 'tldr', read_at: AT, seconds: 1 } };
  const body = await run(h, [ok, theirs, missing]);
  assertEquals(body.acked, [ok.id]);
  assertEquals(body.rejected.sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)), [
    { id: theirs.id, code: 'forbidden', drop: true },
    { id: missing.id, code: 'not_found', drop: true },
  ]);
  assertEquals(h.db.rows('topic_reads').length, 1);
});

test('sync-push mistake_update: the student’s own cause and note are set; an older edit does not overwrite them', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.seed('mistakes', { id: v7(42), user_id: ALICE.id, question_id: IDS.question, attempt_answer_id: v7(43), subject_id: IDS.subject, node_id: IDS.topic, cause: 'didnt_know', suggested_cause: 'didnt_know', cause_source: 'suggested', user_note: null, updated_at: new Date(NOW_MS - 3_600_000).toISOString(), deleted_at: null });
  const fresh = { id: v7(44), kind: 'mistake_update', created_at: AT, payload: { question_id: IDS.question, cause: 'confused', user_note: 'Confundi clorofila com caroteno', updated_at: new Date(NOW_MS - 1000).toISOString() } };
  const stale = { id: v7(45), kind: 'mistake_update', created_at: AT, payload: { question_id: IDS.question, cause: 'careless', updated_at: new Date(NOW_MS - 7_200_000).toISOString() } };
  const body = await run(h, [fresh, stale]);
  assertEquals(body.acked.sort(), [fresh.id, stale.id].sort());
  const row = h.db.rows('mistakes')[0]!;
  assertEquals(row.cause, 'confused');
  assertEquals(row.cause_source, 'user');
  assertEquals(row.user_note, 'Confundi clorofila com caroteno');
});

test('sync-push mistake_update: a question with no mistake of the student is not found', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.seed('mistakes', { id: v7(46), user_id: BOB.id, question_id: IDS.question, cause: 'misread', suggested_cause: 'misread', cause_source: 'suggested', updated_at: AT, deleted_at: null });
  const item = { id: v7(47), kind: 'mistake_update', created_at: AT, payload: { question_id: IDS.question, cause: 'careless', updated_at: NOW.toISOString() } };
  const body = await run(h, [item]);
  assertEquals(body.rejected, [{ id: item.id, code: 'not_found', drop: true }]);
  assertEquals(h.db.rows('mistakes')[0]?.cause, 'misread');
});

test('sync-push note_highlight: created on a readable note, edited last-writer-wins, refused on another student’s note', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.seed('notes', [
    { id: IDS.note, subject_id: IDS.subject, node_id: IDS.topic, deleted_at: null },
    { id: v7(48), subject_id: IDS.bobSubject, node_id: IDS.bobTopic, deleted_at: null },
  ]);
  const create = { id: v7(49), kind: 'note_highlight', created_at: AT, payload: { note_id: IDS.note, start: 4, end: 20, quote: 'clorofila', color: 'yellow', updated_at: AT } };
  const created = await run(h, [create]);
  assertEquals(created.acked, [create.id]);
  const recolor = { id: create.id, kind: 'note_highlight', created_at: AT, payload: { note_id: IDS.note, start: 4, end: 20, quote: 'clorofila', color: 'green', updated_at: new Date(NOW_MS - 1000).toISOString() } };
  const older = { id: create.id, kind: 'note_highlight', created_at: AT, payload: { note_id: IDS.note, start: 4, end: 20, quote: 'clorofila', color: 'pink', updated_at: new Date(NOW_MS - 120_000).toISOString() } };
  await run(h, [recolor]);
  await run(h, [older]);
  assertEquals(h.db.rows('note_highlights')[0]?.color, 'green', 'the older edit does not win');
  const theirs = { id: v7(50), kind: 'note_highlight', created_at: AT, payload: { note_id: v7(48), start: 0, end: 3, quote: 'Do Bob', color: 'blue', updated_at: AT } };
  const body = await run(h, [theirs]);
  assertEquals(body.rejected, [{ id: theirs.id, code: 'forbidden', drop: true }]);
});

test('sync-push feed_impression: a card impression is stored; a session that is not the student’s is stored as null', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const impression = { id: v7(51), kind: 'feed_impression', created_at: AT, payload: { item_kind: 'card', item_ref_id: IDS.card, session_id: v7(52), shown_at: AT, action: 'rated', dwell_ms: 800 } };
  const body = await run(h, [impression]);
  assertEquals(body.acked, [impression.id]);
  const row = h.db.rows('feed_impressions')[0]!;
  assertEquals(row.item_ref_id, IDS.card);
  assertEquals(row.session_id, null, 'the feed visit is not a study session');
  assertEquals(row.dwell_ms, 800);
});

test('sync-push feed_impression: a study session pushed in the same batch is linked; another student’s card is refused', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const session = { id: v7(53), kind: 'study_session', created_at: AT, payload: { kind: 'feed', started_at: AT, active_minutes: 3 } };
  const linked = { id: v7(54), kind: 'feed_impression', created_at: AT, payload: { item_kind: 'card', item_ref_id: IDS.card, session_id: v7(53), shown_at: AT, action: 'answered' } };
  const theirs = { id: v7(55), kind: 'feed_impression', created_at: AT, payload: { item_kind: 'card', item_ref_id: IDS.bobCard, session_id: v7(53), shown_at: AT, action: 'read' } };
  const body = await run(h, [linked, session, theirs]);
  assertEquals(body.acked.sort(), [linked.id, session.id].sort());
  assertEquals(body.rejected, [{ id: theirs.id, code: 'forbidden', drop: true }]);
  assertEquals(h.db.rows('feed_impressions')[0]?.session_id, v7(53));
});

test('sync-push feed_impression: a row without an action is invalid and dropped', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const impression = { id: v7(56), kind: 'feed_impression', created_at: AT, payload: { item_kind: 'card', item_ref_id: IDS.card, session_id: v7(57), shown_at: AT } };
  const body = await run(h, [impression]);
  assertEquals(body.rejected, [{ id: impression.id, code: 'invalid', drop: true }]);
});

test('sync-push card_override: the student’s front and back are stored last-writer-wins; another student’s card is forbidden', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const set = { id: v7(58), kind: 'card_override', created_at: AT, payload: { card_id: IDS.card, front: 'Qual pigmento capta luz?', back: 'Clorofila', updated_at: new Date(NOW_MS - 1000).toISOString() } };
  const stale = { id: v7(59), kind: 'card_override', created_at: AT, payload: { card_id: IDS.card, front: 'antigo', updated_at: new Date(NOW_MS - 600_000).toISOString() } };
  const theirs = { id: v7(60), kind: 'card_override', created_at: AT, payload: { card_id: IDS.bobCard, front: 'x', updated_at: AT } };
  const body = await run(h, [set, stale, theirs]);
  assertEquals(body.acked.sort(), [set.id, stale.id].sort());
  assertEquals(body.rejected, [{ id: theirs.id, code: 'forbidden', drop: true }]);
  const row = h.db.rows('card_overrides')[0]!;
  assertEquals(row.front, 'Qual pigmento capta luz?');
  assertEquals(row.back, 'Clorofila');
  assertEquals(h.db.rows('card_overrides').length, 1);
});

test('sync-push card_override: a media value that is not an object is invalid and dropped', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const bad = { id: v7(61), kind: 'card_override', created_at: AT, payload: { card_id: IDS.card, media: 'not-an-object', updated_at: AT } };
  const body = await run(h, [bad]);
  assertEquals(body.rejected, [{ id: bad.id, code: 'invalid', drop: true }]);
  assertEquals(h.db.rows('card_overrides').length, 0);
});

test('sync-push: a repeated batch of every new kind changes nothing the second time', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.seed('notes', { id: IDS.note, subject_id: IDS.subject, node_id: IDS.topic, deleted_at: null });
  const batch = [
    { id: v7(62), kind: 'topic_read', created_at: AT, payload: { node_id: IDS.topic, depth: 'tldr', read_at: AT, seconds: 9 } },
    { id: v7(63), kind: 'xp_event', created_at: AT, payload: { amount: 5, source_feature: 'MOT-01', ref_type: 'quiz', ref_id: IDS.quiz, occurred_at: AT, local_date: '2026-10-27', in_quiet_hours: false } },
    { id: v7(64), kind: 'flag', created_at: AT, payload: { item_type: 'note', item_id: IDS.note, item_version: 1, reason: 'other' } },
  ];
  const first = await run(h, batch);
  const second = await run(h, batch);
  assertEquals(first.acked.sort(), second.acked.sort());
  assertEquals(h.db.rows('topic_reads').length, 1);
  assertEquals(h.db.rows('xp_events').length, 1);
  assertEquals(h.db.rows('content_flags').length, 1);
});
