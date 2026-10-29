// The sync transport over the API: `sync-push` and `sync-pull`, both answered over SSE. The server pulls one page of a
// mirrored table after the keyset cursor, as the student (row level security), in (updated_at, ...pk) order.
import { uuidv7 } from 'uuidv7';
import { SyncTransportError, type SyncErrorKind } from '../db/sync/errors';
import type { PullRequest, PullResponse, PushRequest, PushResponse, SyncTransport } from '../db/sync/transport';
import { isApiError } from './errors';
import { callFunction } from './functions';

function kindOf(status: number, code: string | undefined): SyncErrorKind {
  if (code === 'app_update_required' || status === 426) return 'upgrade_required';
  if (code === 'unauthorized' || status === 401) return 'auth';
  if (code === 'offline' || status === 0) return 'offline';
  if (status === 429 || code === 'rate_limited') return 'transient';
  return 'server';
}

function toSyncError(error: unknown): SyncTransportError {
  if (error instanceof SyncTransportError) return error;
  if (isApiError(error)) {
    return new SyncTransportError(kindOf(error.status, error.code), error.message, error.code);
  }
  return new SyncTransportError('transient', error instanceof Error ? error.message : String(error));
}

export function createSupabaseSyncTransport(): SyncTransport {
  return {
    async push(req: PushRequest): Promise<PushResponse> {
      try {
        return await callFunction<PushRequest, PushResponse>('sync-push', req, { idempotencyKey: uuidv7() });
      } catch (error) {
        throw toSyncError(error);
      }
    },

    async pull(req: PullRequest): Promise<PullResponse> {
      try {
        const res = await callFunction<PullRequest, { rows: Record<string, unknown>[] }>('sync-pull', req);
        return { rows: res.rows ?? [] };
      } catch (error) {
        throw toSyncError(error);
      }
    },
  };
}
