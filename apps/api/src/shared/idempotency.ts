// Idempotency-Key handling (api.md §2.4). Rows live in private.idempotency_keys for 24 h, keyed by
// (user, function, key). A placeholder row (status 102) is written before the work starts, so two
// concurrent first calls cannot both run the side effects. A stale placeholder (crashed call) is
// released after 10 minutes. Live streams join in memory; startup resolves orphaned placeholders (ADR 0010).
import type { SupabaseClient } from '@supabase/supabase-js';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IN_FLIGHT_STALE_MS = 10 * 60 * 1000;
const IN_FLIGHT = 102;

export interface StoredResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface IdempotencyHandle {
  complete(stored: StoredResponse): Promise<void>;
  /** Releases the key so the same request can run again (failed calls, transient errors). */
  abort(): Promise<void>;
}

export type IdempotencyOutcome =
  | { kind: 'new'; handle: IdempotencyHandle }
  | { kind: 'replay'; stored: StoredResponse }
  | { kind: 'mismatch' }
  /** The same key is still running. */
  | { kind: 'in_flight' };

export interface BeginArgs {
  userId: string;
  fn: string;
  key: string;
  requestHash: string;
  now: Date;

}

interface KeyRow {
  request_hash: string;
  status_code: number;
  response: StoredResponse | null;
  created_at: string;
}

export async function beginIdempotent(db: SupabaseClient, args: BeginArgs): Promise<IdempotencyOutcome> {
  // A fresh builder per statement: the private-schema query object is mutable, so reusing one would carry the
  // filters of the previous statement into the next.
  const table = () => db.schema('private').from('idempotency_keys');
  const match = { user_id: args.userId, function_name: args.fn, key: args.key };

  const { data, error } = await table()
    .select('request_hash, status_code, response, created_at')
    .eq('user_id', match.user_id)
    .eq('function_name', match.function_name)
    .eq('key', match.key)
    .maybeSingle();
  if (error) throw error;

  if (data) {
    const row = data as KeyRow;
    const age = args.now.getTime() - new Date(row.created_at).getTime();
    const expired = age > IDEMPOTENCY_TTL_MS;
    const stale = row.status_code === IN_FLIGHT && age > IN_FLIGHT_STALE_MS;
    if (!expired && !stale) {
      if (row.request_hash !== args.requestHash) return { kind: 'mismatch' };
      if (row.status_code === IN_FLIGHT) return { kind: 'in_flight' };
      if (row.response) return { kind: 'replay', stored: row.response };
      return { kind: 'in_flight' };
    }
    const removed = await table().delete().eq('user_id', match.user_id).eq('function_name', match.function_name).eq('key', match.key);
    if (removed.error) throw removed.error;
  }

  const inserted = await table().insert({
    user_id: args.userId,
    function_name: args.fn,
    key: args.key,
    request_hash: args.requestHash,
    status_code: IN_FLIGHT,
    response: null,
    created_at: args.now.toISOString(),
  });
  if (inserted.error) {
    // 23505: another request won the race for the same key.
    if (inserted.error.code === '23505') return { kind: 'in_flight' };
    throw inserted.error;
  }

  return { kind: 'new', handle: idempotencyHandle(db, args.userId, args.fn, args.key) };
}

/** Ownership of a request placeholder and its final stored response. */
export function idempotencyHandle(db: SupabaseClient, userId: string, fn: string, key: string): IdempotencyHandle {
  const table = () => db.schema('private').from('idempotency_keys');
  return {
    async complete(stored: StoredResponse) {
      const res = await table().update({ status_code: stored.status, response: stored }).eq('user_id', userId).eq('function_name', fn).eq('key', key);
      if (res.error) throw res.error;
    },
    async abort() {
      await table().delete().eq('user_id', userId).eq('function_name', fn).eq('key', key);
    },
  };
}

/** SHA-256 hex of the raw request body. Equal bodies under one key replay; different bodies conflict. */
export async function hashBody(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
