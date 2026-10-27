// The queue surface the framework uses. Production wraps pg-boss (createPgBossBackend); tests use the
// in-memory backend in test/support. Keeping the surface small makes the job runner testable without
// a live queue, and keeps pg-boss v12 specifics (queues must exist before send/work) in one place.
import type { PgBoss } from 'pg-boss';

export interface QueueJob {
  id: string;
  name: string;
  data: unknown;
  /** Failed attempts so far (0 on the first run). */
  retryCount: number;
}

export interface QueueOptions {
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  expireInSeconds: number;
  /** `short` makes singletonKey enforce one queued job per key (pg-boss v12). Used by singleton queues only. */
  policy?: 'standard' | 'short';
}

/**
 * Queues whose every send carries a singletonKey. Under pg-boss v12 the key is enforced only by the `short`
 * policy, so these queues get it; ingest.document keeps `standard` because some of its sends have no key.
 */
export const SINGLETON_QUEUES: ReadonlySet<string> = new Set([
  'batch.poll',
  'notify.deliver',
  'ingest.topic_content',
  'ingest.prerequisites',
  'ingest.render_pages',
  'ingest.transcribe_pages',
  'notify.live',
]);

export function policyFor(name: string): 'standard' | 'short' {
  return SINGLETON_QUEUES.has(name) ? 'short' : 'standard';
}

export interface SendOptions {
  startAfter?: Date | number;
  singletonKey?: string;
}

export interface QueueBackend {
  getQueue(name: string): Promise<unknown | null>;
  createQueue(name: string, options: QueueOptions): Promise<void>;
  send(name: string, data: Record<string, unknown>, options?: SendOptions): Promise<string | null>;
  work(
    name: string,
    options: { localConcurrency: number },
    handler: (jobs: QueueJob[]) => Promise<void>,
  ): Promise<void>;
  schedule(name: string, cron: string): Promise<void>;
  stop(): Promise<void>;
}

/** pg-boss v12 backend. Creates a queue on first use (createQueue is required before send or work). */
export function createPgBossBackend(boss: PgBoss): QueueBackend {
  return {
    async getQueue(name) {
      return boss.getQueue(name);
    },
    async createQueue(name, options) {
      await boss.createQueue(name, options);
    },
    async send(name, data, options) {
      const sendOptions: Record<string, unknown> = {};
      if (options?.startAfter !== undefined) sendOptions.startAfter = options.startAfter;
      if (options?.singletonKey !== undefined) sendOptions.singletonKey = options.singletonKey;
      return boss.send(name, data, sendOptions);
    },
    async work(name, options, handler) {
      await boss.work(name, { localConcurrency: options.localConcurrency, pollingIntervalSeconds: 2 }, async (jobs) => {
        const list = (Array.isArray(jobs) ? jobs : [jobs]) as Array<{ id: string; name: string; data: unknown; retryCount: number }>;
        await handler(list.map((j) => ({ id: j.id, name: j.name, data: j.data, retryCount: j.retryCount ?? 0 })));
      });
    },
    async schedule(name, cron) {
      await boss.schedule(name, cron, {}, {});
    },
    async stop() {
      await boss.stop({ graceful: true, timeout: 30_000 });
    },
  };
}
