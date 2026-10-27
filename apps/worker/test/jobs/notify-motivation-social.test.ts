import { beforeEach, describe, expect, it } from 'vitest';
import { handleNotifyDispatch } from '../../src/jobs/notify.ts';
import { handleStreaksRollover, handleXpAward } from '../../src/jobs/motivation.ts';
import { handleBattleTick, handleDuelExpire, handleInsightsRecompute } from '../../src/jobs/social.ts';
import { FakeEnv, GROUP_ID, NOW, QUESTION, SUBJECT, USER, fakeEnv } from './fakes.ts';
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

describe('battle.tick (SOC-03.4, idempotent on index and status)', () => {
  function seedBattle(status = 'question_open') {
    env.db.seed('quizzes', [{ id: 'quiz-b', question_ids: [QUESTION, 'q-2'] }]);
    env.db.seed('battles', [
      {
        id: 'battle-1',
        class_group_id: GROUP_ID,
        quiz_id: 'quiz-b',
        status,
        current_index: 0,
        question_opens_at: '2026-10-27T14:59:50.000Z',
        question_closes_at: '2026-10-27T15:00:00.000Z',
        seconds_per_question: 20,
        ended_at: null,
      },
    ]);
    env.db.seed('battle_players', [{ battle_id: 'battle-1', user_id: USER, score: 0, answer_streak: 0, quiz_attempt_id: 'att-u' }]);
    env.db.seed('attempt_answers', [{ attempt_id: 'att-u', question_id: QUESTION, correct: true, answered_at: '2026-10-27T14:59:53.000Z' }]);
  }

  it('closes the question, scores the player, and schedules the reveal (idempotent on a repeat)', async () => {
    seedBattle();
    expect(await handleBattleTick(env.ctx, { battle_id: 'battle-1', index: 0 })).toMatchObject({ status: 'closed', scored: 1 });
    const battle = env.db.rows('battles')[0];
    expect(battle?.status).toBe('question_reveal');
    expect(env.db.rows('battle_players')[0]).toMatchObject({ answer_streak: 1 });
    expect(env.db.rows('battle_players')[0]?.score).toBeGreaterThan(500);
    expect(env.enqueued.at(-1)).toMatchObject({ name: 'battle.tick', data: { battle_id: 'battle-1', index: 0 } });
    // a duplicate close arriving during the reveal does nothing (no early advance, no double score)
    const score = env.db.rows('battle_players')[0]?.score;
    expect(await handleBattleTick(env.ctx, { battle_id: 'battle-1', index: 0 })).toEqual({ status: 'noop' });
    expect(env.db.rows('battle_players')[0]?.score).toBe(score);
    expect(env.db.rows('battles')[0]?.status).toBe('question_reveal');
  });

  it('advances after the reveal window and ignores a stale tick for another index', async () => {
    seedBattle('question_reveal');
    env.setNow('2026-10-27T15:00:11.000Z');
    expect(await handleBattleTick(env.ctx, { battle_id: 'battle-1', index: 0 })).toEqual({ status: 'advanced' });
    expect(env.db.rows('battles')[0]).toMatchObject({ status: 'question_open', current_index: 1 });
    expect(await handleBattleTick(env.ctx, { battle_id: 'battle-1', index: 0 })).toEqual({ status: 'noop' });
  });

  it('a failed claim (someone else closed it first) changes nothing (failure path)', async () => {
    seedBattle('lobby');
    expect(await handleBattleTick(env.ctx, { battle_id: 'battle-1', index: 0 })).toEqual({ status: 'noop' });
    expect(env.db.rows('battle_players')[0]?.score).toBe(0);
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

