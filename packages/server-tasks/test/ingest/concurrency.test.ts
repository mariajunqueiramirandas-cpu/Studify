import { describe, expect, it } from 'vitest';
import { priorityLimiter } from '../../src/ingest/concurrency.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('priorityLimiter', () => {
  it('never runs more than its size at once and starts the lowest priority waiting first', async () => {
    const limit = priorityLimiter(2);
    let active = 0;
    let peak = 0;
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const task = (name: string, priority: number) =>
      limit(priority, async () => {
        active += 1;
        peak = Math.max(peak, active);
        started.push(name);
        await new Promise<void>((resolve) => releases.set(name, resolve));
        active -= 1;
        return name;
      });

    const done = [task('a', 5), task('b', 5), task('late', 9), task('urgent', 0), task('same', 5)];
    await tick();
    expect(started).toEqual(['a', 'b']);
    releases.get('a')!();
    await tick();
    releases.get('b')!();
    await tick();
    // 'urgent' was asked for after 'late' but goes first; equal priorities keep their order.
    expect(started).toEqual(['a', 'b', 'urgent', 'same']);
    releases.get('urgent')!();
    releases.get('same')!();
    await tick();
    releases.get('late')!();
    expect(await Promise.all(done)).toEqual(['a', 'b', 'late', 'urgent', 'same']);
    expect(peak).toBe(2);
  });

  it('frees the slot when a task throws', async () => {
    const limit = priorityLimiter(1);
    await expect(limit(0, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await limit(0, async () => 'next')).toBe('next');
  });
});
