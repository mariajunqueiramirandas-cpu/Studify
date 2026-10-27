// Supabase implementation of the sync transport: `sync-push` Edge Function + PostgREST pulls.
import { uuidv7 } from 'uuidv7';
import { cursorOrFilter } from '../db/sync/cursor';
import { SyncTransportError, type SyncErrorKind } from '../db/sync/errors';
import type { PullFilter, PullRequest, PullResponse, PushRequest, PushResponse, SyncTransport } from '../db/sync/transport';
import { ApiError, isApiError } from './errors';
import { callFunction } from './functions';
import { supabase } from './supabase';

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

// PostgREST builder types are not generated for this project (no Database type yet).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFilter(query: any, filter: PullFilter): any {
  switch (filter.op) {
    case 'in':
      return query.in(filter.column, filter.value);
    case 'eq':
      return query.eq(filter.column, filter.value);
    case 'gte':
      return query.gte(filter.column, filter.value);
    case 'lte':
      return query.lte(filter.column, filter.value);
    case 'is_null':
      return query.is(filter.column, null);
  }
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query: any = supabase.from(req.table).select(req.select.join(','));
      for (const filter of req.filters) query = applyFilter(query, filter);
      if (req.cursor.updatedAt !== null && req.cursor.key !== null) {
        query = query.or(cursorOrFilter(req.pk, req.cursor.updatedAt, req.cursor.key));
      }
      query = query.order('updated_at', { ascending: true });
      for (const column of req.pk) query = query.order(column, { ascending: true });
      query = query.limit(req.limit);

      const { data, error, status } = await query;
      if (error) {
        const message = String(error.message ?? 'Falha ao sincronizar');
        const code = status === 401 ? 'unauthorized' : status === 0 || /network/i.test(message) ? 'offline' : undefined;
        throw toSyncError(new ApiError(code ?? 'unknown', status ?? 0, message));
      }
      return { rows: (data ?? []) as Record<string, unknown>[] };
    },
  };
}
