import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
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
});
