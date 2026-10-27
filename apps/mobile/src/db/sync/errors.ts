import { BACKOFF_BASE_MS, BACKOFF_CAP_MS } from './constants';

/**
 * How a transport failure should be handled by the engine:
 * - `offline`: no connectivity or rate limited; wait for a trigger, rows are untouched.
 * - `transient`: retry with backoff; rows are untouched.
 * - `server`: retry with backoff (the same as transient for batches).
 * - `upgrade_required`: HTTP 426. Stop syncing and ask the user to update.
 * - `auth`: the session is gone. Stop syncing until the user signs in again.
 */
export type SyncErrorKind = 'offline' | 'transient' | 'server' | 'upgrade_required' | 'auth';

export class SyncTransportError extends Error {
  readonly kind: SyncErrorKind;
  readonly code: string | undefined;

  constructor(kind: SyncErrorKind, message: string, code?: string) {
    super(message);
    this.name = 'SyncTransportError';
    this.kind = kind;
    this.code = code;
  }
}

/** Delay before the next automatic attempt after `failures` consecutive failed syncs (failures >= 1). */
export function backoffDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  const exp = BACKOFF_BASE_MS * 2 ** (failures - 1);
  return Math.min(exp, BACKOFF_CAP_MS);
}
