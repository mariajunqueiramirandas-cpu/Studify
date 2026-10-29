// Worker execute and push helpers (api §7, §9). The Edge side only enqueues; the worker consumes.
import type { P2Deps } from './deps.ts';
import { inBackground } from '../shared/deps.ts';
import { secondsUntil } from './util.ts';
import { ApiFailure } from '@studify/shared';

/** Schedules a job to run at `at` (duel.expire, battle.tick). `singletonKey` makes re-scheduling a no-op. */
export async function scheduleAt(
  deps: P2Deps,
  queue: string,
  data: Record<string, unknown>,
  at: Date,
  singletonKey: string,
): Promise<string> {
  const id = await deps.execute(queue, data, { startAfterSeconds: secondsUntil(at, deps.now()), singletonKey });
  if (id === null) throw new ApiFailure('internal_error', { message: `Não consegui agendar ${queue}.` });
  return id;
}

/** Push through notify.dispatch (quiet hours, cap and toggles are applied by the worker, PLT-05). */
export async function pushTo(deps: P2Deps, userId: string, type: string, data: Record<string, unknown>): Promise<void> {
  await inBackground(deps, 'notify.dispatch', { user_id: userId, type, data }, `push:${type}:${userId}:${String(data.duel_id ?? data.battle_id ?? data.exam_id ?? '')}`);
}
