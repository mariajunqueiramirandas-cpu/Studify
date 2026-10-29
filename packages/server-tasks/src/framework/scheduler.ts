// Calendar triggers only. Immediate work never enters this store: callers invoke handlers directly.
// Delayed notifications, battle deadlines and budget resets survive API restarts.
import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { ApiFailure } from '@studify/shared';
import type { Sql } from './db.ts';
import type { Logger } from './logger.ts';

export interface ScheduleOptions { startAfter?: Date | number; singletonKey?: string }
/** A trigger refused because its operation was at its concurrency limit fires again this many seconds later. */
export const BUSY_RETRY_S = 5;
export type Schedule = (name: string, data: Record<string, unknown>, options?: ScheduleOptions) => Promise<string | null>;
export class Scheduler {
  #timer?: ReturnType<typeof setInterval>;
  #ticking: Promise<void> | null = null;
  #running = new Set<Promise<unknown>>();
  #cron = new Map<string, { expression: string; next: Date }>();
  /** `singletonKey` is the caller's key: a trigger joins a run of the same key that is still going instead of repeating it. */
  constructor(private sql: Sql, private log: Logger, private run: (name: string, data: Record<string, unknown>, singletonKey?: string) => Promise<unknown>) {}
  cron(name: string, expression: string): void {
    this.#cron.set(name, { expression, next: CronExpressionParser.parse(expression, { tz: 'UTC' }).next().toDate() });
  }
  schedule: Schedule = async (name, data, options = {}) => {
    const id = randomUUID();
    const due = options.startAfter instanceof Date ? options.startAfter : new Date(Date.now() + (options.startAfter ?? 0) * 1000);
    const result = await this.sql.query<{ id: string }>(
      `insert into private.scheduled_actions (id, name, data, due_at, singleton_key) values ($1,$2,$3,$4,$5)
       on conflict (singleton_key) do nothing returning id`,
      [id, name, JSON.stringify(data), due, options.singletonKey ? `${name}:${options.singletonKey}` : null],
    );
    return result.rows[0]?.id ?? null;
  };
  async start(): Promise<void> {
    // Fail startup when migrations are missing instead of silently dropping timed features.
    await this.sql.query('select id from private.scheduled_actions limit 0');
    this.#timer = setInterval(() => {
      if (this.#ticking) return;
      this.#ticking = this.tick().catch((err) => this.log.error({ err }, 'scheduled action failed')).finally(() => { this.#ticking = null; });
    }, 1000);
    this.#timer.unref();
  }
  async tick(): Promise<void> {
    const now = new Date();
    for (const [name, cron] of this.#cron) {
      if (cron.next > now) continue;
      cron.next = CronExpressionParser.parse(cron.expression, { currentDate: now, tz: 'UTC' }).next().toDate();
      // Stable per-minute key also prevents duplicate triggers during overlapping deployments.
      await this.schedule(name, {}, { singletonKey: `cron:${now.toISOString().slice(0, 16)}` });
    }
    if (this.#running.size >= 16) return;
    // Delete and return atomically: a timed action fires at most once, with no retry/lease/worker machinery.
    const { rows } = await this.sql.query<{ name: string; data: Record<string, unknown>; singleton_key: string | null }>(
      `delete from private.scheduled_actions where id in
       (select id from private.scheduled_actions where due_at <= now() order by due_at limit $1 for update skip locked)
       returning name, data, singleton_key`, [16 - this.#running.size],
    );
    for (const { name, data, singleton_key: singletonKey } of rows) {
      const key = singletonKey?.startsWith(`${name}:`) ? singletonKey.slice(name.length + 1) : undefined;
      const running = this.run(name, data, key).catch(async (err) => {
        // The operation never started (it was at its concurrency limit): background work waits a little, it is not lost.
        if (err instanceof ApiFailure && err.code === 'rate_limited') {
          await this.sql.query(
            `insert into private.scheduled_actions (id, name, data, due_at, singleton_key) values ($1,$2,$3,$4,$5)
             on conflict (singleton_key) do nothing`,
            [randomUUID(), name, JSON.stringify(data), new Date(Date.now() + BUSY_RETRY_S * 1000), singletonKey],
          ).catch((retryErr) => this.log.error({ name, err: retryErr }, 'scheduled action could not be re-scheduled'));
          return;
        }
        this.log.error({ name, err }, 'scheduled action failed; manual retry required');
      });
      this.#running.add(running);
      void running.finally(() => this.#running.delete(running));
    }
  }
  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    await this.#ticking;
    await Promise.allSettled([...this.#running]);
  }
}
