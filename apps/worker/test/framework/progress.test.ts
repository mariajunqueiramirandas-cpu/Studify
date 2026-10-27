import { describe, expect, it } from 'vitest';
import { applyProgress, isUuid } from '../../src/framework/progress.ts';
import type { Sql } from '../../src/framework/db.ts';

function capture() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = { async query(text: string, values: unknown[] = []) { calls.push({ text, values }); return { rows: [] }; } } as unknown as Sql;
  return { sql, calls };
}

describe('applyProgress', () => {
  it('sets only the fields in the patch and derives progress from the counts', async () => {
    const { sql, calls } = capture();
    await applyProgress(sql, 'job-1', { stage: 'S2', items_total: 4, items_done: 1 });
    const { text, values } = calls[0]!;
    expect(text).toContain('stage = $2');
    expect(text).toContain('progress = $3');
    expect(text).toContain('items_total = $4');
    expect(text).not.toContain('status =');
    expect(values).toEqual(['job-1', 'S2', 0.25, 4, 1]);
  });

  it('stamps finished_at on terminal states and started_at on running', async () => {
    const { sql, calls } = capture();
    await applyProgress(sql, 'job-1', { status: 'running' });
    expect(calls[0]?.text).toContain('started_at = coalesce(started_at, now())');
    await applyProgress(sql, 'job-1', { status: 'failed', error_code: 'corrupt' });
    expect(calls[1]?.text).toContain('finished_at = now()');
    expect(calls[1]?.values).toContain('ingest.error.corrupt');
  });

  it('does nothing for an empty patch', async () => {
    const { sql, calls } = capture();
    await applyProgress(sql, 'job-1', {});
    expect(calls).toHaveLength(0);
  });
});

describe('isUuid', () => {
  it('accepts canonical UUIDs only', () => {
    expect(isUuid('0190f3a2-7b1c-7d3e-8f00-000000000001')).toBe(true);
    expect(isUuid('job-1')).toBe(false);
  });
});
