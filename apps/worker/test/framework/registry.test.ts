import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { JobRegistry, type RuntimeDeps } from '../../src/framework/registry.ts';
import { PermanentJobError } from '../../src/framework/errors.ts';
import type { JobDefinition } from '../../src/framework/types.ts';
import { InMemoryQueue } from '../ingest/support/fakes.ts';

/** Records ai_jobs writes so the mirror can be asserted without a database. */
function recordingPool() {
  const writes: Array<{ text: string; values: unknown[] }> = [];
  const rowsByPgboss = new Map<string, string>();
  const pool = {
    async query(text: string, values: unknown[] = []) {
      writes.push({ text, values });
      if (text.includes('select id from public.ai_jobs where pgboss_job_id')) {
        const id = rowsByPgboss.get(String(values[0]));
        return { rows: id ? [{ id }] : [] };
      }
      if (text.includes('insert into public.ai_jobs')) {
        const id = randomUUID();
        rowsByPgboss.set(String(values[4]), id);
        return { rows: [{ id }] };
      }
      return { rows: [] };
    },
  };
  return { pool: pool as unknown as RuntimeDeps['pool'], writes };
}

function deps(backend: InMemoryQueue, pool: RuntimeDeps['pool']): RuntimeDeps {
  const log = { child: () => log, info() {}, warn() {}, error() {}, debug() {} } as unknown as RuntimeDeps['log'];
  const push = { push: async () => 'sent', deliverDeferred: async () => 'sent', checkReceipts: async () => 0 } as unknown as RuntimeDeps['push'];
  return { backend, pool, supabase: {} as RuntimeDeps['supabase'], claude: {} as RuntimeDeps['claude'], push, log, now: () => new Date('2026-10-27T12:00:00Z') };
}

describe('JobRegistry', () => {
  it('creates queues with the definition retry policy and runs the handler with payload and meta', async () => {
    const backend = new InMemoryQueue();
    const { pool } = recordingPool();
    const registry = new JobRegistry(deps(backend, pool));
    const seen: unknown[] = [];
    const def: JobDefinition<{ n: number }> = {
      name: 'test.echo',
      retryLimit: 5,
      handler: async (_ctx, data, meta) => {
        seen.push({ data, attempt: meta.attempt });
      },
    };
    await registry.register([def]);
    expect(backend.queues.get('test.echo')).toMatchObject({ retryLimit: 5, retryBackoff: true, retryDelay: 10 });
    await registry.enqueue('test.echo', { n: 7 });
    await backend.drain();
    expect(seen).toEqual([{ data: { n: 7 }, attempt: 1 }]);
  });

  it('retries a throwing handler and records the final failure', async () => {
    const backend = new InMemoryQueue();
    const { pool } = recordingPool();
    const registry = new JobRegistry(deps(backend, pool));
    let calls = 0;
    await registry.register([
      {
        name: 'test.flaky',
        retryLimit: 2,
        handler: async () => {
          calls++;
          throw new Error('transient');
        },
      },
    ]);
    await registry.enqueue('test.flaky', {});
    await backend.drain();
    expect(calls).toBe(3); // first attempt plus two retries
    expect(backend.failedJobs).toEqual([{ name: 'test.flaky', error: 'transient' }]);
  });

  it('completes a job with a permanent error without retrying and marks ai_jobs failed', async () => {
    const backend = new InMemoryQueue();
    const { pool, writes } = recordingPool();
    const registry = new JobRegistry(deps(backend, pool));
    let calls = 0;
    const documentId = randomUUID();
    await registry.register([
      {
        name: 'test.permanent',
        handler: async () => {
          calls++;
          throw new PermanentJobError('corrupt');
        },
      },
    ]);
    await registry.enqueue('test.permanent', { document_id: documentId });
    await backend.drain();
    expect(calls).toBe(1);
    expect(backend.failedJobs).toEqual([]);
    const failed = writes.find((w) => w.text.includes("status = $2") && w.values.includes('failed'));
    expect(failed).toBeDefined();
    expect(failed?.values).toContain('corrupt');
    expect(failed?.values).toContain('ingest.error.corrupt');
  });

  it('rejects duplicate job names at registration', async () => {
    const backend = new InMemoryQueue();
    const { pool } = recordingPool();
    const registry = new JobRegistry(deps(backend, pool));
    const def: JobDefinition = { name: 'dup', handler: async () => undefined };
    await expect(registry.register([def, def])).rejects.toThrow(/duplicate job name/);
  });

  it('passes singletonKey and startAfter through to the backend', async () => {
    const backend = new InMemoryQueue();
    const { pool } = recordingPool();
    const registry = new JobRegistry(deps(backend, pool));
    await registry.register([]);
    const id = await registry.enqueue('batch.poll', { plan: {} }, { singletonKey: 'k', startAfter: 60 });
    expect(id).not.toBeNull();
    expect(backend.sent[0]?.options).toEqual({ singletonKey: 'k', startAfter: 60 });
    expect(await registry.enqueue('batch.poll', { plan: {} }, { singletonKey: 'k' })).toBeNull();
  });
});

describe('ai_jobs mirror', () => {
  it('uses the payload ai_job_id without creating a row', async () => {
    const backend = new InMemoryQueue();
    const { pool, writes } = recordingPool();
    const registry = new JobRegistry(deps(backend, pool));
    const aiJob = randomUUID();
    let seen: string | null = null;
    await registry.register([
      {
        name: 'test.with_ai_job',
        handler: async (_ctx, _data, meta) => {
          seen = meta.aiJobId;
        },
      },
    ]);
    await registry.enqueue('test.with_ai_job', { ai_job_id: aiJob, document_id: randomUUID() });
    await backend.drain();
    expect(seen).toBe(aiJob);
    expect(writes.some((w) => w.text.includes('insert into public.ai_jobs'))).toBe(false);
  });

  it('does not touch the ai_jobs row of a job that only observes it (notify.live)', async () => {
    const backend = new InMemoryQueue();
    const { pool, writes } = recordingPool();
    const registry = new JobRegistry(deps(backend, pool));
    let seen: string | null | undefined;
    await registry.register([
      {
        name: 'test.observer',
        observesAiJob: true,
        handler: async (_ctx, _data, meta) => {
          seen = meta.aiJobId;
        },
      },
    ]);
    await registry.enqueue('test.observer', { ai_job_id: randomUUID() });
    await backend.drain();
    expect(seen).toBeNull();
    // Marking the job running would queue another notify.live and revive finished jobs.
    expect(writes.some((w) => w.text.includes('update public.ai_jobs'))).toBe(false);
  });
});

describe('applyProgress', () => {
  it('never moves a finished job back to a non-terminal status, and then notifies no one', async () => {
    const { applyProgress, setProgressListener } = await import('../../src/framework/progress.ts');
    const queries: string[] = [];
    const sql = {
      async query(text: string) {
        queries.push(text);
        return { rows: [], rowCount: 0 };
      },
    };
    const heard: string[] = [];
    setProgressListener((id) => heard.push(id));
    try {
      await applyProgress(sql as never, 'job-1', { status: 'running' });
      expect(queries[0]).toContain(`status not in ('succeeded', 'failed', 'cancelled')`);
      expect(heard).toEqual([]);
      await applyProgress(sql as never, 'job-1', { status: 'succeeded' });
      expect(queries[1]).not.toContain('status not in');
      expect(heard).toEqual(['job-1']);
    } finally {
      setProgressListener(null);
    }
  });
});

