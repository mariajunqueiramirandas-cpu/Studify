// pg-boss enqueue (ADR 0005, api §7). The API sends jobs with the same pg-boss version as the worker; the
// worker owns the schema and creates the queues, so a send to an unknown queue fails with a clear error.
import type { PgBoss, SendOptions } from 'pg-boss';
import { ApiFailure } from '@studify/shared';
import type { Enqueue, EnqueueOptions } from './deps.ts';

/** `ready` resolves once the boss is started (sends need a started instance). */
export function makePgBossEnqueue(boss: PgBoss, ready: () => Promise<void>): Enqueue {
  return async (queue: string, data: Record<string, unknown>, options: EnqueueOptions = {}): Promise<string | null> => {
    await ready();
    const sendOptions: SendOptions = {};
    if (options.singletonKey !== undefined) sendOptions.singletonKey = options.singletonKey;
    if (options.singletonSeconds !== undefined) sendOptions.singletonSeconds = options.singletonSeconds;
    if (options.startAfterSeconds !== undefined) sendOptions.startAfter = options.startAfterSeconds;
    if (options.retryLimit !== undefined) sendOptions.retryLimit = options.retryLimit;
    try {
      // Resolves null when a singleton with the same key is already queued (expected for debounced jobs).
      return await boss.send(queue, data, sendOptions);
    } catch (err) {
      if (err instanceof Error && /does not exist/.test(err.message)) {
        throw new ApiFailure('internal_error', { message: `fila ${queue} não existe` });
      }
      throw err;
    }
  };
}
