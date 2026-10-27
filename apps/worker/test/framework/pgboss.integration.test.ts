// Round trip through the real pg-boss v12 backend: queue creation, send, work, retry and stop. Uses its own
// schema so it never touches the pgboss schema of a real deployment. Skipped when the database is unreachable.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { createPgBossBackend, type QueueOptions } from '../../src/framework/queue.ts';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/studify_test_worker';

async function reachable(): Promise<boolean> {
  const boss = new PgBoss({ connectionString: DATABASE_URL, schema: 'pgboss_framework_test', max: 1 });
  try {
    await boss.start();
    await boss.stop({ graceful: false });
    return true;
  } catch {
    return false;
  }
}

const READY = await reachable();

describe.skipIf(!READY)('pg-boss backend', () => {
  it('creates a queue, delivers a job to the worker and honours singleton keys', async () => {
    const boss = new PgBoss({ connectionString: DATABASE_URL, schema: 'pgboss_framework_test', max: 2 });
    await boss.start();
    try {
      const backend = createPgBossBackend(boss);
      const name = `test.echo.${randomUUID().slice(0, 8)}`;
      const options: QueueOptions = { retryLimit: 1, retryDelay: 1, retryBackoff: false, expireInSeconds: 300, policy: 'short' };
      expect(await backend.getQueue(name)).toBeNull();
      await backend.createQueue(name, options);
      expect(await backend.getQueue(name)).not.toBeNull();

      // Both sends happen before a worker exists, so the second one is blocked by the first (still queued).
      const id = await backend.send(name, { n: 42 }, { singletonKey: `k-${name}` });
      expect(id).not.toBeNull();
      expect(await backend.send(name, { n: 43 }, { singletonKey: `k-${name}` })).toBeNull();

      const received = new Promise<Record<string, unknown>>((resolve) => {
        void backend.work(name, { localConcurrency: 1 }, async (jobs) => {
          resolve(jobs[0]?.data as Record<string, unknown>);
        });
      });
      expect(await received).toEqual({ n: 42 });
    } finally {
      await boss.stop({ graceful: false });
    }
  }, 60_000);
});
