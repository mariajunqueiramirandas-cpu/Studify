import { beforeEach, describe, expect, it } from 'vitest';
import { handleNotifyDispatch } from '../../src/jobs/notify.ts';
import { handleStreaksRollover, handleXpAward } from '../../src/jobs/motivation.ts';
import { handleBattleTick, handleDuelExpire, handleInsightsRecompute } from '../../src/jobs/social.ts';
import { FakeEnv, GROUP_ID, NOW, QUESTION, SUBJECT, USER, USER_B, fakeEnv } from './fakes.ts';
import { seedStudent } from './seed.ts';

let env: FakeEnv;
beforeEach(() => {
  env = fakeEnv(NOW);
  seedStudent(env.db);
  env.db.seed('push_tokens', [{ user_id: USER, token: 'ExponentPushToken[abc]', device_id: 'd1', invalidated_at: null }]);
});

describe('notify.dispatch (PLT-05): catalog in, push service out', () => {
  it('hands a server push to the push service with the catalog channel, copy and deep link', async () => {
    const result = await handleNotifyDispatch(env.ctx, { user_id: USER, type: 'export_ready', data: { export_id: 'e1' } });
    expect(result).toEqual({ status: 'handed_off' });
    expect(env.pushed).toEqual([
      expect.objectContaining({
        userId: USER,
        message: expect.objectContaining({ channel: 'processing', requested: true, data: expect.objectContaining({ type: 'export_ready', deep_link: 'studify://profile/privacy' }) }),
      }),
    ]);
    // the job itself writes no notification_log rows: the push service does
    expect(env.db.rows('notification_log')).toHaveLength(0);
  });

  it('marks unrequested types as counting toward the daily cap (PLT-05.4)', async () => {
    await handleNotifyDispatch(env.ctx, { user_id: USER, type: 'subject_shared', data: { subject_id: 's1' } });
    expect(env.pushed[0]?.message).toMatchObject({ channel: 'class', requested: false, data: expect.objectContaining({ deep_link: `studify://subjects/s1` }) });
  });

  it('prefers the producer-supplied body and title over the catalog copy (duel-create PT-BR text)', async () => {
    await handleNotifyDispatch(env.ctx, {
      user_id: USER,
      type: 'duel_challenge',
      data: { class_group_id: 'g-1', duel_id: 'duel-9', nome: 'Ana', materia: 'Biologia', body: 'Ana te desafiou num duelo de Biologia!' },
    });
    expect(env.pushed[0]?.message).toMatchObject({
      title: 'Novo desafio',
      body: 'Ana te desafiou num duelo de Biologia!',
      data: expect.objectContaining({ deep_link: 'studify://class/g-1/duel/duel-9' }),
    });
  });

  it('a blank producer body falls back to the catalog copy', async () => {
    await handleNotifyDispatch(env.ctx, { user_id: USER, type: 'duel_challenge', data: { class_group_id: 'g-1', duel_id: 'd', body: '   ' } });
    expect(env.pushed[0]?.message).toMatchObject({ body: 'Um colega te desafiou para um duelo.' });
  });

  it('never pushes local-only or unknown types', async () => {
    expect(await handleNotifyDispatch(env.ctx, { user_id: USER, type: 'reviews_due', data: {} })).toEqual({ status: 'local_only' });
    expect(await handleNotifyDispatch(env.ctx, { user_id: USER, type: 'mystery', data: {} })).toEqual({ status: 'unknown_type' });
    expect(env.pushed).toHaveLength(0);
  });

  it('a transport failure propagates so pg-boss retries (failure path)', async () => {
    env.ctx.push = async () => {
      throw new Error('expo 503');
    };
    await expect(handleNotifyDispatch(env.ctx, { user_id: USER, type: 'content_fixed', data: {} })).rejects.toThrow(/expo 503/);
  });
});

describe('xp.award (MOT-01)', () => {
  const events = [
    { event: { kind: 'card_reviewed' }, ref_type: 'card_reviewed', ref_id: 'rev-1', source_feature: 'MEM-02', occurred_at: NOW },
    { event: { kind: 'daily_goal_met' }, ref_type: 'daily_goal_met', ref_id: 'goal-2026-10-27', source_feature: 'MOT-01', occurred_at: NOW },
  ];

  it('awards XP once per (user, ref, feature): a repeat changes nothing', async () => {
    const first = await handleXpAward(env.ctx, { user_id: USER, events });
    expect(first).toEqual({ awarded: 11, inserted: 2, skipped: 0 });
    expect(env.db.rows('xp_events')).toHaveLength(2);
    const second = await handleXpAward(env.ctx, { user_id: USER, events });
    expect(second).toEqual({ awarded: 0, inserted: 0, skipped: 2 });
    expect(env.db.rows('xp_events')).toHaveLength(2);
  });

  it('rejects an unknown event kind (failure path)', async () => {
    await expect(handleXpAward(env.ctx, { user_id: USER, events: [{ ...events[0], event: { kind: 'coins' } }] })).rejects.toThrow();
  });
});

describe('streaks.rollover (MOT-01, learning-engine §17.3)', () => {
  it('closes study days into daily_activity and a streak state, and is idempotent', async () => {
    env.db.seed('review_logs', Array.from({ length: 12 }, (_v, i) => ({ id: `r${i}`, user_id: USER, card_id: `c${i}`, rating: 3, reviewed_at: '2026-10-25T13:00:00Z', reason: 'due', undoes_log_id: null })));
    const first = await handleStreaksRollover(env.ctx, { user_ids: [USER] });
    expect(first).toEqual({ users: 1, rolled: 1 });
    const days = env.db.rows('daily_activity').map((d) => d.local_date).sort();
    expect(days).toEqual(['2026-10-25', '2026-10-26']);
    expect(env.db.rows('daily_activity').find((d) => d.local_date === '2026-10-25')).toMatchObject({ reviews: 12, counted: true, goal_met: false });
    expect(env.db.rows('streaks')[0]).toMatchObject({ user_id: USER, current_length: 0, longest_length: 1, last_counted_date: '2026-10-26' });
    const again = await handleStreaksRollover(env.ctx, { user_ids: [USER] });
    expect(again).toEqual({ users: 1, rolled: 0 });
    expect(env.db.rows('daily_activity')).toHaveLength(2);
  });
});

describe('duel.expire (SOC-02.10)', () => {
  it('expires a waiting duel once and is a no-op afterwards', async () => {
    env.db.seed('duels', [{ id: 'duel-1', status: 'waiting_opponent', expires_at: '2026-10-26T00:00:00Z' }]);
    expect(await handleDuelExpire(env.ctx, { duel_id: 'duel-1' })).toEqual({ status: 'expired' });
    expect(env.db.rows('duels')[0]?.status).toBe('expired');
    expect(await handleDuelExpire(env.ctx, { duel_id: 'duel-1' })).toEqual({ status: 'noop' });
  });

  it('does not expire a duel whose time has not come', async () => {
    env.db.seed('duels', [{ id: 'duel-2', status: 'waiting_opponent', expires_at: '2026-10-30T00:00:00Z' }]);
    expect(await handleDuelExpire(env.ctx, { duel_id: 'duel-2' })).toEqual({ status: 'not_yet' });
    expect(env.db.rows('duels')[0]?.status).toBe('waiting_opponent');
  });
});

describe('battle.tick (SOC-03.4, idempotent on index and status; api §8.2 broadcasts)', () => {
  const BATTLE = 'battle-1';
  const CHANNEL = 'battle:battle-1';
  const Q2 = 'q-2';

  /** Two questions: an mcq (A–D, correct B) and a true/false. `answers` are the attempts that answered question 1. */
  function seedBattle(opts: { status?: string; index?: number; closesAt?: string; answers?: Array<{ user: string; choice: string | null }> } = {}) {
    const status = opts.status ?? 'question_open';
    const index = opts.index ?? 0;
    env.db.seed('questions', [
      {
        id: QUESTION,
        subject_id: SUBJECT,
        node_id: 'node-x',
        type: 'mcq_single',
        stem: 'Qual organela produz ATP?',
        stimulus: null,
        payload: {
          options: [
            { id: 'A', text: 'Núcleo' },
            { id: 'B', text: 'Mitocôndria' },
            { id: 'C', text: 'Ribossomo' },
            { id: 'D', text: 'Golgi' },
          ],
          correct: 'B',
        },
        explanation: 'A respiração celular acontece na mitocôndria.',
        deleted_at: null,
      },
      {
        id: Q2,
        subject_id: SUBJECT,
        node_id: 'node-x',
        type: 'true_false',
        stem: 'Afirmação',
        stimulus: null,
        payload: { statement: 'A clorofila capta luz.', correct: true, justification: 'Justificativa.' },
        explanation: null,
        deleted_at: null,
      },
    ]);
    env.db.seed('quizzes', [{ id: 'quiz-b', question_ids: [QUESTION, Q2] }]);
    env.db.seed('battles', [
      {
        id: BATTLE,
        class_group_id: GROUP_ID,
        quiz_id: 'quiz-b',
        status,
        current_index: index,
        question_opens_at: '2026-10-27T14:59:50.000Z',
        question_closes_at: opts.closesAt ?? '2026-10-27T15:00:00.000Z',
        seconds_per_question: 20,
        ended_at: null,
      },
    ]);
    const answers = opts.answers ?? [
      { user: USER, choice: 'B' },
      { user: USER_B, choice: 'C' },
    ];
    const nickname = (user: string, i: number) => (user === USER ? 'Ana' : user === USER_B ? 'Bia' : `Jogador${i}`);
    env.db.seed(
      'battle_players',
      answers.map((a, i) => ({ battle_id: BATTLE, user_id: a.user, nickname: nickname(a.user, i), score: 0, answer_streak: 0, quiz_attempt_id: `att-${i}` })),
    );
    env.db.seed(
      'attempt_answers',
      answers.map((a, i) => ({
        attempt_id: `att-${i}`,
        question_id: QUESTION,
        correct: a.choice === 'B',
        response: a.choice === null ? null : { choice: a.choice },
        answered_at: '2026-10-27T14:59:53.000Z',
      })),
    );
  }

  it('closes the question, scores the players, writes state reveal and the reveal event, and schedules the reveal', async () => {
    seedBattle();
    expect(await handleBattleTick(env.ctx, { battle_id: BATTLE, index: 0 })).toMatchObject({ status: 'closed', scored: 2 });
    expect(env.db.rows('battles')[0]?.status).toBe('reveal');
    const ana = env.db.rows('battle_players').find((p) => p.user_id === USER);
    expect(ana).toMatchObject({ answer_streak: 1 });
    expect(ana?.score).toBeGreaterThan(500);
    expect(env.enqueued.at(-1)).toMatchObject({ name: 'battle.tick', data: { battle_id: BATTLE, index: 0 } });

    expect(env.broadcasts.map((b) => b.event)).toEqual(['state', 'reveal']);
    expect(env.broadcasts.every((b) => b.topic === CHANNEL && b.private)).toBe(true);
    expect(env.broadcasts[0]?.payload).toEqual({ status: 'reveal', current_index: 0, total: 2 });
    expect(env.broadcasts[1]?.payload).toMatchObject({
      index: 0,
      correct_response: { choice: 'B' },
      explanation: 'A respiração celular acontece na mitocôndria.',
      distribution: null, // two answers: below the five-answer threshold (SOC-03.10)
      leaderboard: [
        { user_id: USER, nickname: 'Ana', rank: 1 },
        { user_id: USER_B, nickname: 'Bia', rank: 2, score: 0 },
      ],
    });
  });

  it('shows the distribution from five answers, counting only answers that were accepted', async () => {
    seedBattle({
      answers: [
        { user: USER, choice: 'B' },
        { user: 'p-a', choice: 'B' },
        { user: 'p-b', choice: 'B' },
        { user: 'p-c', choice: 'C' },
        { user: 'p-d', choice: 'A' },
      ],
    });
    await handleBattleTick(env.ctx, { battle_id: BATTLE, index: 0 });
    expect(env.broadcasts.find((b) => b.event === 'reveal')?.payload.distribution).toEqual({ A: 20, B: 60, C: 20, D: 0 });
  });

  it('a duplicate close during the reveal does nothing: no second score, no second broadcast', async () => {
    seedBattle();
    await handleBattleTick(env.ctx, { battle_id: BATTLE, index: 0 });
    const score = env.db.rows('battle_players').find((p) => p.user_id === USER)?.score;
    const sent = env.broadcasts.length;
    expect(await handleBattleTick(env.ctx, { battle_id: BATTLE, index: 0 })).toEqual({ status: 'noop' });
    expect(env.db.rows('battle_players').find((p) => p.user_id === USER)?.score).toBe(score);
    expect(env.broadcasts.length).toBe(sent);
    expect(env.db.rows('battles')[0]?.status).toBe('reveal');
  });

  it('advances after the reveal window: state question_open carries the next question without its answer key', async () => {
    seedBattle({ status: 'reveal', index: 0 });
    env.setNow('2026-10-27T15:00:11.000Z');
    expect(await handleBattleTick(env.ctx, { battle_id: BATTLE, index: 0 })).toEqual({ status: 'advanced' });
    expect(env.db.rows('battles')[0]).toMatchObject({ status: 'question_open', current_index: 1 });
    expect(env.broadcasts).toHaveLength(1);
    const state = env.broadcasts[0]!;
    expect(state).toMatchObject({ topic: CHANNEL, event: 'state' });
    expect(state.payload).toMatchObject({
      status: 'question_open',
      current_index: 1,
      total: 2,
      players: 2,
      question: { id: Q2, type: 'true_false', payload: { statement: 'A clorofila capta luz.' } },
    });
    expect(JSON.stringify(state.payload)).not.toContain('justification');
    expect(state.payload.opens_at).toBe('2026-10-27T15:00:12.500Z');
    expect(state.payload.closes_at).toBe('2026-10-27T15:00:32.500Z');
    expect(await handleBattleTick(env.ctx, { battle_id: BATTLE, index: 0 })).toEqual({ status: 'noop' });
  });

  it('after the last question: state podium and the podium event with the top three, then ended after the podium window', async () => {
    seedBattle({ status: 'reveal', index: 1, answers: [{ user: USER, choice: 'B' }, { user: USER_B, choice: 'C' }] });
    env.setNow('2026-10-27T15:00:11.000Z');
    expect(await handleBattleTick(env.ctx, { battle_id: BATTLE, index: 1 })).toEqual({ status: 'podium' });
    expect(env.broadcasts.map((b) => b.event)).toEqual(['state', 'podium']);
    expect(env.broadcasts[0]?.payload).toEqual({ status: 'podium', current_index: 1, total: 2 });
    expect(env.broadcasts[1]?.payload.leaderboard).toHaveLength(2);

    env.setNow('2026-10-27T15:02:12.000Z');
    expect(await handleBattleTick(env.ctx, { battle_id: BATTLE, index: 1 })).toEqual({ status: 'ended' });
    expect(env.db.rows('battles')[0]).toMatchObject({ status: 'ended' });
    expect(env.broadcasts.at(-1)).toMatchObject({ event: 'state', payload: { status: 'ended', current_index: 1, total: 2 } });
    expect(env.enqueued.some((e) => e.name === 'insights.recompute')).toBe(true);
  });

  it('a failed Realtime send is logged, not thrown: the close still commits (failure path)', async () => {
    seedBattle();
    env.failBroadcast = 'realtime unavailable';
    expect(await handleBattleTick(env.ctx, { battle_id: BATTLE, index: 0 })).toMatchObject({ status: 'closed' });
    expect(env.db.rows('battles')[0]?.status).toBe('reveal');
    expect(env.enqueued.at(-1)).toMatchObject({ name: 'battle.tick' });
  });

  it('a failed claim (someone else closed it first) changes nothing and broadcasts nothing (failure path)', async () => {
    seedBattle({ status: 'lobby' });
    expect(await handleBattleTick(env.ctx, { battle_id: BATTLE, index: 0 })).toEqual({ status: 'noop' });
    expect(env.db.rows('battle_players').find((p) => p.user_id === USER)?.score).toBe(0);
    expect(env.broadcasts).toHaveLength(0);
  });
});

describe('insights.recompute (SOC-04, k-anonymity)', () => {
  function seedClass(answerers: number) {
    env.db.seed('class_group_members', Array.from({ length: answerers }, (_v, i) => ({ class_group_id: GROUP_ID, user_id: `m-${i}`, status: 'active', contribute_insights: true, role: 'member' })));
    env.db.seed('subjects', [{ id: SUBJECT, owner_class_group_id: GROUP_ID, owner_profile_id: null, deleted_at: null }]);
    env.db.seed('questions', [{ id: QUESTION, subject_id: SUBJECT, node_id: 'node-x', deleted_at: null }]);
    env.db.seed('attempt_answers', Array.from({ length: answerers }, (_v, i) => ({ user_id: `m-${i}`, question_id: QUESTION, correct: i % 2 === 0, response: { choice: i % 2 === 0 ? 'A' : 'C' }, answered_at: `2026-10-27T10:0${i}:00Z` })));
  }

  it('writes no insight for a question with fewer than five answerers', async () => {
    seedClass(4);
    await handleInsightsRecompute(env.ctx, { class_group_id: GROUP_ID });
    expect(env.pgQueries.filter((q) => q.text.startsWith('insert into private.class_insights'))).toHaveLength(0);
  });

  it('writes the aggregate once five distinct members answered', async () => {
    seedClass(5);
    const result = await handleInsightsRecompute(env.ctx, { class_group_id: GROUP_ID });
    expect(result.questions).toBe(1);
    const inserts = env.pgQueries.filter((q) => q.text.startsWith('insert into private.class_insights'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.values?.slice(0, 5)).toEqual([GROUP_ID, QUESTION, 'node-x', 5, 2]);
  });

  it('leaves out members who opted out of insights', async () => {
    seedClass(5);
    env.db.rows('class_group_members')[0]!.contribute_insights = false;
    await handleInsightsRecompute(env.ctx, { class_group_id: GROUP_ID });
    expect(env.pgQueries.filter((q) => q.text.startsWith('insert into private.class_insights'))).toHaveLength(0);
  });
});


describe('achievements (MOT-01.8, unlock once, catalog codes)', () => {
  it('unlocks the reached achievements on xp.award, keeps the first unlock time, and leaves the rest locked', async () => {
    env.db.seed('review_logs', Array.from({ length: 120 }, (_v, i) => ({ id: `rv-${i}`, user_id: USER, card_id: `c${i}`, rating: 3, reviewed_at: '2026-10-27T13:00:00Z' })));
    const event = (ref: string) => ({ event: { kind: 'card_reviewed' }, ref_type: 'card_reviewed', ref_id: ref, source_feature: 'MEM-02', occurred_at: NOW });
    await handleXpAward(env.ctx, { user_id: USER, events: [event('a')] });
    const rows = (code: string) => env.db.rows('achievements').find((r) => r.code === code);
    expect(rows('first_review')).toMatchObject({ user_id: USER, progress: 1, unlocked_at: NOW });
    expect(rows('cards_100')).toMatchObject({ progress: 100, unlocked_at: NOW });
    expect(rows('cards_1000')).toMatchObject({ progress: 120, unlocked_at: null });
    expect(rows('first_material')).toMatchObject({ progress: 0, unlocked_at: null });
    expect(rows('week_won')).toBeUndefined(); // not computable yet: no row is written

    env.setNow('2026-10-28T10:00:00.000Z');
    await handleXpAward(env.ctx, { user_id: USER, events: [event('b')] });
    expect(rows('first_review')?.unlocked_at).toBe(NOW);
    expect(env.db.rows('achievements').filter((r) => r.code === 'first_review')).toHaveLength(1);
  });

  it('streak achievements come from the longest streak written by the rollover', async () => {
    env.db.seed('streaks', [{ user_id: USER, current_length: 7, longest_length: 7, last_counted_date: '2026-10-26', shields_available: 0, days_since_last_shield_earned: 0, rest_weekday: null }]);
    await handleStreaksRollover(env.ctx, { user_ids: [USER] });
    expect(env.db.rows('achievements').find((r) => r.code === 'streak_7')).toMatchObject({ unlocked_at: NOW, progress: 7 });
    expect(env.db.rows('achievements').find((r) => r.code === 'streak_30')).toMatchObject({ unlocked_at: null, progress: 7 });
  });
});
