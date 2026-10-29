import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ApiFailure } from '@studify/shared';
import { Scheduler } from '../../src/framework/scheduler.ts';
import { createLogger } from '../../src/framework/logger.ts';

const url = process.env.TEST_DATABASE_URL;
const pool = new pg.Pool({ connectionString: url, max: 2 });
const log = createLogger('silent');
describe.skipIf(!url)('calendar triggers against Postgres', () => {
  beforeAll(async () => { await pool.query('delete from private.scheduled_actions'); });
  afterAll(async () => { await pool.query('delete from private.scheduled_actions'); await pool.end(); });
  it('persists future work and deduplicates a calendar key', async () => {
    const calls: string[] = [];
    const scheduler = new Scheduler(pool, log, async (name) => { calls.push(name); });
    const first = await scheduler.schedule('future', {}, { startAfter: 3600, singletonKey: 'calendar-test' });
    expect(first).toBeTruthy();
    expect(await scheduler.schedule('future', {}, { startAfter: 3600, singletonKey: 'calendar-test' })).toBeNull();
    await scheduler.tick();
    expect(calls).toEqual([]);
  });
  it('picks up due work after a scheduler restart and fires it once', async () => {
    const first = new Scheduler(pool, log, async () => {});
    await first.schedule('due', { value: 7 }, { startAfter: new Date(0) });
    const calls: unknown[] = [];
    const restarted = new Scheduler(pool, log, async (name, data) => { calls.push([name, data]); });
    await restarted.tick(); await restarted.tick(); await restarted.stop();
    expect(calls).toEqual([['due', { value: 7 }]]);
  });
  it('a long nightly computation does not block a later battle deadline', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const scheduler = new Scheduler(pool, log, async (name) => { calls.push(name); if (name === 'nightly') await gate; });
    await scheduler.schedule('nightly', {}, { startAfter: new Date(0) });
    await scheduler.tick();
    await scheduler.schedule('battle', {}, { startAfter: new Date(0) });
    await scheduler.tick();
    expect(calls).toEqual(['nightly', 'battle']);
    release(); await scheduler.stop();
  });
  it('re-schedules work its operation was too busy to start, with the same key, and fires it later', async () => {
    const calls: unknown[] = [];
    let busy = true;
    const scheduler = new Scheduler(pool, log, async (name, data) => {
      if (busy) throw new ApiFailure('rate_limited');
      calls.push([name, data]);
    });
    await scheduler.schedule('grading.answer', { attempt_answer_id: 'a1' }, { startAfter: 0, singletonKey: 'a1' });
    await scheduler.tick(); await scheduler.stop();
    const parked = await pool.query<{ singleton_key: string; due_at: Date }>(`select singleton_key, due_at from private.scheduled_actions where name = 'grading.answer'`);
    expect(parked.rows.map((r) => r.singleton_key)).toEqual(['grading.answer:a1']);
    expect(parked.rows[0]!.due_at.getTime()).toBeGreaterThan(Date.now());
    // The same key is still taken while it waits: a second request for that answer does not add another run.
    expect(await scheduler.schedule('grading.answer', { attempt_answer_id: 'a1' }, { startAfter: 0, singletonKey: 'a1' })).toBeNull();
    busy = false;
    await pool.query(`update private.scheduled_actions set due_at = now() - interval '1 second' where name = 'grading.answer'`);
    await scheduler.tick(); await scheduler.stop();
    expect(calls).toEqual([['grading.answer', { attempt_answer_id: 'a1' }]]);
  });
});
