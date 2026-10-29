import { describe, expect, it } from 'vitest';
import { OperationRegistry, type RuntimeDeps } from '../../src/framework/registry.ts';

function harness() {
  const log = { child: () => log, info() {}, error() {} } as unknown as RuntimeDeps['log'];
  const scheduled: unknown[] = [];
  const writes: unknown[] = [];
  const registry = new OperationRegistry({
    log, pool: { query: async (...args: unknown[]) => { writes.push(args); return { rows: [] }; } } as unknown as RuntimeDeps['pool'],
    supabase: {} as RuntimeDeps['supabase'], claude: {} as RuntimeDeps['claude'],
    push: {} as RuntimeDeps['push'], now: () => new Date(),
    schedule: async (...args) => { scheduled.push(args); return 'calendar-id'; },
  });
  return { registry, scheduled, writes };
}

describe('direct server operations', () => {
  it('starts immediately, awaits completion and invokes nested operations directly', async () => {
    const { registry, scheduled } = harness();
    const calls: string[] = [];
    await registry.register([
      { name: 'parent', handler: async (ctx) => { calls.push('parent'); await ctx.execute('child', {}); calls.push('finished'); } },
      { name: 'child', handler: async () => { calls.push('child'); } },
    ]);
    await registry.execute('parent', {});
    expect(calls).toEqual(['parent', 'child', 'finished']);
    expect(scheduled).toEqual([]);
  });
  it('propagates a failure once without a hidden paid retry', async () => {
    const { registry } = harness();
    let attempts = 0;
    await registry.register([{ name: 'fail', handler: async () => { attempts++; throw new Error('failure'); } }]);
    await expect(registry.execute('fail', {})).rejects.toThrow('failure');
    expect(attempts).toBe(1);
  });
  it('joins active singleton work and releases it after completion', async () => {
    const { registry } = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let attempts = 0;
    await registry.register([{ name: 'slow', handler: async () => { attempts++; await gate; } }]);
    const first = registry.execute('slow', {}, { singletonKey: 'same' });
    const second = registry.execute('slow', {}, { singletonKey: 'same' });
    release();
    expect(await second).toBe(await first);
    expect(attempts).toBe(1);
    await registry.execute('slow', {}, { singletonKey: 'same' });
    expect(attempts).toBe(2);
  });
  it('stores only explicitly delayed actions in the calendar', async () => {
    const { registry, scheduled } = harness();
    let ran = false;
    await registry.register([{ name: 'notify', handler: async () => { ran = true; } }]);
    expect(await registry.execute('notify', { hello: true }, { startAfter: 60 })).toBe('calendar-id');
    expect(ran).toBe(false);
    expect(scheduled).toHaveLength(1);
  });
  it('rejects unknown handlers, duplicate definitions, and work after shutdown', async () => {
    const { registry } = harness();
    await expect(registry.execute('missing', {})).rejects.toThrow('unknown operation');
    const def = { name: 'echo', handler: async () => {} };
    await expect(registry.register([def, def])).rejects.toThrow('duplicate operation');
    await registry.stop();
    await expect(registry.execute('echo', {})).rejects.toThrow('stopping');
  });
});

it('rejects capacity overflow immediately, without delaying or queuing a paid operation', async () => {
  const { registry, scheduled } = harness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await registry.register([{ name: 'limited', concurrency: 1, handler: async () => { await gate; } }]);
  const active = registry.execute('limited', {});
  await expect(registry.execute('limited', {})).rejects.toMatchObject({ code: 'rate_limited' });
  expect(scheduled).toEqual([]);
  release(); await active;
  await expect(registry.execute('limited', {})).resolves.toBeTruthy();
});
