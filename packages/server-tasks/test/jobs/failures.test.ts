// One failure path for each job that did not have one in its own module test.
import { beforeEach, describe, expect, it } from 'vitest';
import { handleMasteryRecompute, handleNotesPrefetch, handleSrsOptimize } from '../../src/jobs/learning.ts';
import { handleStreaksRollover } from '../../src/jobs/motivation.ts';
import { handleDuelExpire } from '../../src/jobs/social.ts';
import { handleStoragePurge } from '../../src/jobs/account.ts';
import { FakeEnv, NOW, TOPIC, USER, fakeEnv } from './fakes.ts';
import { seedStudent } from './seed.ts';

let env: FakeEnv;
beforeEach(() => {
  env = fakeEnv(NOW);
  seedStudent(env.db);
});

describe('failure paths', () => {
  it('notes.prefetch_deep surfaces a read failure for retry', async () => {
    env.db.seed('exams', [{ id: 'e', user_id: USER, subject_id: null, goal_id: 'g', local_date: '2026-10-30', status: 'scheduled', deleted_at: null }]);
    env.db.failures.set('exam_scope_nodes', 'statement timeout');
    await expect(handleNotesPrefetch(env.ctx)).rejects.toThrow(/statement timeout/);
    expect(env.enqueued).toHaveLength(0);
  });

  it('srs.optimize_params surfaces a read failure and does not report a skip', async () => {
    env.db.failures.set('review_logs', 'connection reset');
    await expect(handleSrsOptimize(env.ctx, { user_id: USER })).rejects.toThrow(/connection reset/);
  });

  it('streaks.rollover surfaces a database failure so the hourly run retries', async () => {
    env.db.seed('review_logs', [{ id: 'r', user_id: USER, card_id: 'c', rating: 3, reviewed_at: '2026-10-25T13:00:00Z', reason: 'due', undoes_log_id: null }]);
    env.db.failures.set('daily_activity', 'deadlock');
    await expect(handleStreaksRollover(env.ctx, { user_ids: [USER] })).rejects.toThrow(/deadlock/);
    expect(env.db.rows('streaks')).toHaveLength(0);
  });

  it('duel.expire reports an unknown duel as not_found and changes nothing', async () => {
    expect(await handleDuelExpire(env.ctx, { duel_id: 'missing' })).toEqual({ status: 'not_found' });
  });

  it('storage.purge records a failing table and still purges the others', async () => {
    env.db.failures.set('goals', 'permission denied');
    env.db.seed('cards', [{ id: 'old', deleted_at: '2026-08-01T00:00:00Z' }]);
    const outcome = await handleStoragePurge(env.ctx, {});
    expect(outcome.errors).toEqual({ goals: 'permission denied' });
    expect(outcome.purged.cards).toBe(1);
  });

  it('mastery.recompute reports a missing profile quietly instead of inventing rows', async () => {
    env.db.seed('profiles', []);
    expect(await handleMasteryRecompute(env.ctx, { user_id: USER, node_ids: [TOPIC] })).toEqual({ updated: 0, shifted: [], replanQueued: false });
  });
});
