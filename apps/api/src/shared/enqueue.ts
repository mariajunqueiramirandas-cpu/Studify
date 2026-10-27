// pg-boss enqueue (ADR 0005, api §7). pg-boss 12 has no SQL `send` function: the worker's own INSERT
// is `insertJobs` (node_modules/pg-boss/dist/plans.js). This helper runs the same INSERT for one job
// through a direct Postgres connection (DATABASE_URL). The queue row must exist: the worker creates
// queues at startup. Verify the column list against the deployed pg-boss version in staging.
import type postgres from 'postgres';
import type { Enqueue, EnqueueOptions } from './deps.ts';
import { ApiFailure } from '@studify/shared';

export function makePgBossEnqueue(sql: postgres.Sql, uuid: () => string): Enqueue {
  return async (queue: string, data: Record<string, unknown>, options: EnqueueOptions = {}): Promise<string | null> => {
    const startAfter = options.startAfterSeconds ?? 0;
    const singletonSeconds = options.singletonSeconds ?? null;
    const rows = await sql`
      INSERT INTO pgboss.job (
        id, name, data, priority, start_after, created_on, singleton_key, singleton_on,
        expire_seconds, deletion_seconds, keep_until, retry_limit, retry_delay, retry_backoff,
        policy, dead_letter, heartbeat_seconds, blocked, blocking, pending_dependencies
      )
      SELECT
        ${uuid()}::uuid, q.name, ${JSON.stringify(data)}::jsonb, 0,
        now() + make_interval(secs => ${startAfter}),
        pgboss.job_now(),
        ${options.singletonKey ?? null},
        CASE WHEN ${singletonSeconds}::int IS NULL THEN NULL
             ELSE to_timestamp(floor(extract(epoch FROM pgboss.job_now()) / ${singletonSeconds}::int) * ${singletonSeconds}::int)
        END,
        q.expire_seconds, q.deletion_seconds,
        now() + (q.retention_seconds * interval '1 second'),
        COALESCE(${options.retryLimit ?? null}::int, q.retry_limit), q.retry_delay, q.retry_backoff,
        q.policy, q.dead_letter, q.heartbeat_seconds, false, false, 0
      FROM pgboss.queue q
      WHERE q.name = ${queue}
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    if (rows.length === 0) {
      // Either a singleton is already queued (expected for debounced jobs) or the queue is missing.
      const exists = await sql`SELECT 1 FROM pgboss.queue WHERE name = ${queue}`;
      if (exists.length === 0) throw new ApiFailure('internal_error', { message: `fila ${queue} não existe` });
      return null;
    }
    return String((rows[0] as { id: string }).id);
  };
}
