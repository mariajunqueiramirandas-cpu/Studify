import { test } from 'bun:test';
// Battle handlers (SOC-03): PIN uniqueness among live battles, host-only control, late-join limit (SOC-03.7),
// server-timed acceptance (SOC-03.5), IDOR, the state/reveal/podium contract and the 5-answer distribution rule.
import { assert, assertEquals } from './assert.ts';
import { handler as battleControl } from '../src/functions/battle-control.ts';
import { handler as battleJoin } from '../src/functions/battle-join.ts';
import { handler as battleAnswer } from '../src/functions/battle-answer.ts';
import { distributionOf, leaderboardTop, revealEvent, stateEvent } from '../src/shared-p2/battle.ts';
import {
  baseTables,
  BOB,
  CAROL,
  createFakeDb,
  createFakeDeps,
  type FakeEnv,
  GROUP,
  json,
  post,
  type Row,
  SUBJECT,
  USERS,
} from './p2_fakes.ts';
import { uuidV7 } from '@studify/shared';

const T0 = new Date('2026-10-27T12:00:00Z');
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

function env(opts: { extra?: Record<string, Row[]>; randomInts?: number[] } = {}): FakeEnv {
  const tables = baseTables();
  for (const [k, v] of Object.entries(opts.extra ?? {})) tables[k] = [...(tables[k] ?? []), ...v];
  return createFakeDeps({ db: createFakeDb({ tables, users: USERS }), now: T0, randomInts: opts.randomInts });
}

async function createBattle(e: FakeEnv, jwt = 'jwt-alice'): Promise<{ battle_id: string; pin: string }> {
  const res = await battleControl(
    post({ action: 'create', class_group_id: GROUP, subject_id: SUBJECT, count: 5, seconds_per_question: 20 }, { jwt }),
    e.deps,
  );
  assertEquals(res.status, 200, await res.clone().text());
  return (await json(res)) as unknown as { battle_id: string; pin: string };
}

function join(e: FakeEnv, jwt: string, pin: string): Promise<Response> {
  return battleJoin(post({ pin }, { jwt }), e.deps);
}

function control(e: FakeEnv, jwt: string, body: Record<string, unknown>): Promise<Response> {
  return battleControl(post(body, { jwt }), e.deps);
}

async function answer(
  e: FakeEnv,
  jwt: string,
  battleId: string,
  index: number,
  choice: string,
): Promise<Record<string, unknown>> {
  const res = await battleAnswer(
    post({ battle_id: battleId, question_index: index, response: { choice }, answer_id: uuidV7() }, { jwt }),
    e.deps,
  );
  assertEquals(res.status, 200, await res.clone().text());
  return json(res);
}

test('PIN: a PIN held by a live battle is skipped (SOC-03.2 uniqueness)', async () => {
  const e = env({
    extra: {
      battles: [{
        id: '00000000-0000-4000-8000-0000000000b1',
        class_group_id: GROUP,
        host_id: BOB,
        quiz_id: 'q0',
        pin: '0042',
        status: 'lobby',
        current_index: 0,
      }],
    },
    randomInts: [42, 4242],
  });
  const created = await createBattle(e);
  assertEquals(created.pin, '4242');
});

test('PIN: a battle that already ended does not hold its PIN', async () => {
  const e = env({
    extra: {
      battles: [{
        id: '00000000-0000-4000-8000-0000000000b1',
        class_group_id: GROUP,
        host_id: BOB,
        quiz_id: 'q0',
        pin: '0042',
        status: 'ended',
        current_index: 3,
      }],
    },
    randomInts: [42],
  });
  const created = await createBattle(e);
  assertEquals(created.pin, '0042');
});

test('battle-control create: 403 when the Turma restricts hosting to owner and moderators', async () => {
  const e = env({ extra: {} });
  (e.db.tables.class_groups![0] as Row).settings = { battles_host: 'owner_mods' };
  const res = await control(e, 'jwt-bob', { action: 'create', class_group_id: GROUP, subject_id: SUBJECT, count: 5 });
  assertEquals(res.status, 403);
  const owner = await control(e, 'jwt-alice', {
    action: 'create',
    class_group_id: GROUP,
    subject_id: SUBJECT,
    count: 5,
  });
  assertEquals(owner.status, 200);
});

test('battle-control: 404 for a non-member and 403 for a member who is not the host', async () => {
  const e = env();
  const created = await createBattle(e);
  const carol = await control(e, 'jwt-carol', { action: 'start', battle_id: created.battle_id });
  assertEquals(carol.status, 404);
  const bob = await control(e, 'jwt-bob', { action: 'start', battle_id: created.battle_id });
  assertEquals(bob.status, 403);
});

test('battle-control start: needs 2 players; then opens question 1 with the state event and no answer key', async () => {
  const e = env();
  const created = await createBattle(e);
  const alone = await control(e, 'jwt-alice', { action: 'start', battle_id: created.battle_id });
  assertEquals(alone.status, 400);
  assertEquals((await join(e, 'jwt-alice', created.pin)).status, 200);
  assertEquals((await join(e, 'jwt-bob', created.pin)).status, 200);
  e.setNow(T0);
  const started = await control(e, 'jwt-alice', { action: 'start', battle_id: created.battle_id });
  assertEquals(started.status, 200);
  const state = e.broadcasts.find((m) => m.topic === `battle:${created.battle_id}` && m.event === 'state');
  assertEquals(state?.payload.status, 'question_open');
  assertEquals(state?.payload.current_index, 0);
  assertEquals(state?.payload.total, 5);
  assertEquals(state?.payload.opens_at, at(1.5).toISOString());
  assertEquals(state?.payload.closes_at, at(21.5).toISOString());
  assert(!JSON.stringify(state?.payload).includes('"correct"'));
  assert(
    e.sent.some((s) =>
      s.queue === 'battle.tick' && s.options?.startAfterSeconds === 22 &&
      s.options?.singletonKey === `battle-tick:${created.battle_id}:0`
    ),
  );
  assert(e.broadcasts.every((m) => m.private === true));
});

test('battle-answer: rejected before the window opens, accepted inside it, rejected after closes_at + 1 s', async () => {
  const e = env();
  const created = await createBattle(e);
  await join(e, 'jwt-alice', created.pin);
  await join(e, 'jwt-bob', created.pin);
  await control(e, 'jwt-alice', { action: 'start', battle_id: created.battle_id });

  e.setNow(at(1));
  assertEquals(await answer(e, 'jwt-bob', created.battle_id, 0, 'b'), { accepted: false });
  e.setNow(at(3));
  const inside = await answer(e, 'jwt-bob', created.battle_id, 0, 'b');
  assertEquals(inside, { accepted: true });
  assertEquals(Object.keys(inside), ['accepted']);
  e.setNow(at(3.5));
  assertEquals(await answer(e, 'jwt-alice', created.battle_id, 0, 'a'), { accepted: true });
  e.setNow(at(23));
  assertEquals(await answer(e, 'jwt-alice', created.battle_id, 1, 'a'), { accepted: false });
  e.setNow(at(22.4));
  assertEquals(
    await answer(e, 'jwt-alice', created.battle_id, 0, 'c'),
    { accepted: false },
    'a second answer for the same question is not accepted',
  );
});

test('battle-answer: 403 for a Turma member who did not join the battle (no IDOR)', async () => {
  const e = env();
  const created = await createBattle(e);
  await join(e, 'jwt-alice', created.pin);
  await join(e, 'jwt-bob', created.pin);
  await control(e, 'jwt-alice', { action: 'start', battle_id: created.battle_id });
  e.setNow(at(3));
  const res = await battleAnswer(
    post({ battle_id: created.battle_id, question_index: 0, response: { choice: 'b' }, answer_id: uuidV7() }, {
      jwt: 'jwt-carol',
    }),
    e.deps,
  );
  assertEquals(res.status, 403);
});

test('battle-join: 404 for an unknown PIN; members join by PIN; late join closed from question 3 (SOC-03.7)', async () => {
  const e = env({
    extra: {
      class_group_members: [{
        class_group_id: GROUP,
        user_id: CAROL,
        role: 'member',
        status: 'active',
        nickname: 'Cá',
        accepts_duels: true,
      }],
    },
  });
  const created = await createBattle(e);
  assertEquals((await join(e, 'jwt-carol', '9999')).status, 404);
  const outsider = await join(e, 'jwt-carol', created.pin);
  assertEquals(outsider.status, 200, 'Carol is an active member in this fixture');
  (e.db.tables.battles![0] as Row).status = 'question_open';
  (e.db.tables.battles![0] as Row).current_index = 2;
  const late = await join(e, 'jwt-bob', created.pin);
  assertEquals(late.status, 400);
  (e.db.tables.battles![0] as Row).current_index = 1;
  const allowed = await join(e, 'jwt-bob', created.pin);
  assertEquals(allowed.status, 200);
  const rejoin = await json(await join(e, 'jwt-bob', created.pin));
  assertEquals(rejoin.rejoined, true);
});

test('next moves from reveal to the next question; from any other state it is refused; end broadcasts the podium', async () => {
  const e = env();
  const created = await createBattle(e);
  await join(e, 'jwt-alice', created.pin);
  await join(e, 'jwt-bob', created.pin);
  await control(e, 'jwt-alice', { action: 'start', battle_id: created.battle_id });
  const refused = await control(e, 'jwt-alice', { action: 'next', battle_id: created.battle_id });
  assertEquals(refused.status, 400);
  (e.db.tables.battles![0] as Row).status = 'reveal';
  e.setNow(at(40));
  const moved = await control(e, 'jwt-alice', { action: 'next', battle_id: created.battle_id });
  assertEquals(moved.status, 200);
  assertEquals((e.db.tables.battles![0] as Row).current_index, 1);
  const ended = await control(e, 'jwt-alice', { action: 'end', battle_id: created.battle_id });
  assertEquals(ended.status, 200);
  const podium = e.broadcasts.find((m) => m.event === 'podium');
  assert(Array.isArray((podium?.payload as { leaderboard: unknown[] }).leaderboard));
});

test('kick removes the player and only the host may kick', async () => {
  const e = env();
  const created = await createBattle(e);
  await join(e, 'jwt-bob', created.pin);
  const byBob = await control(e, 'jwt-bob', { action: 'kick', battle_id: created.battle_id, user_id: BOB });
  assertEquals(byBob.status, 403);
  const res = await control(e, 'jwt-alice', { action: 'kick', battle_id: created.battle_id, user_id: BOB });
  assertEquals(res.status, 200);
  assertEquals(e.db.tables.battle_players?.length, 0);
});

// ---- pure contract checks (coordinator payloads, SOC-03.10) ----

test('distribution is hidden under 5 answers and shown from 5 (SOC-03.10)', () => {
  assertEquals(distributionOf(['a', 'b', 'b', 'c'], ['a', 'b', 'c', 'd']), null);
  const shown = distributionOf(['b', 'b', 'a', 'b', 'c'], ['a', 'b', 'c', 'd']);
  assertEquals(shown, { a: 20, b: 60, c: 20, d: 0 });
});

test('reveal event carries distribution null below the threshold and the top 5 leaderboard only', () => {
  const players = Array.from({ length: 8 }, (_, i) => ({ user_id: `u${i}`, nickname: `P${i}`, score: 100 - i * 10 }));
  const board = leaderboardTop(players);
  assertEquals(board.length, 5);
  assertEquals(board[0], { user_id: 'u0', nickname: 'P0', score: 100, rank: 1 });
  const reveal = revealEvent({ index: 0, correctResponse: { choice: 'b' }, distribution: null, leaderboard: board });
  assertEquals(reveal.payload.distribution, null);
  assertEquals(stateEvent({ status: 'reveal', currentIndex: 0, total: 5 }).payload.status, 'reveal');
});

test('leaderboard ranks ties together (competition ranking)', () => {
  const board = leaderboardTop([
    { user_id: 'a', nickname: 'A', score: 300 },
    { user_id: 'b', nickname: 'B', score: 300 },
    { user_id: 'c', nickname: 'C', score: 100 },
  ]);
  assertEquals(board.map((r: { rank: number }) => r.rank), [1, 1, 3]);
});
