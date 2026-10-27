// Supabase implementation of the sync transport: `sync-push` Edge Function + PostgREST pulls.
import { uuidv7 } from 'uuidv7';
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

/** Lexicographic keyset condition for PostgREST `or`: (updated_at, ...pk) > cursor. */
export function cursorOrFilter(pk: string[], updatedAt: string, key: (string | number)[]): string {
  const quote = (v: string) => `"${v.replace(/"/g, '\\"')}"`;
  const ts = quote(updatedAt);
  const clauses = [`updated_at.gt.${ts}`];
  pk.forEach((column, i) => {
    const equalities = pk
      .slice(0, i)
      .map((c, j) => `${c}.eq.${quote(String(key[j]))}`)
      .map((e) => `,${e}`)
      .join('');
    clauses.push(`and(updated_at.eq.${ts}${equalities},${column}.gt.${quote(String(key[i]))})`);
  });
  return clauses.join(',');
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
