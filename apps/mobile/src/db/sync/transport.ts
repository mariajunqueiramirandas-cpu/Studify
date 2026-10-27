// The engine talks to the server only through this interface, so it runs in Node tests with a
// fake transport and on device with the Supabase transport (supabase-transport.ts).

export type PullFilter =
  | { column: string; op: 'in'; value: string[] }
  | { column: string; op: 'eq' | 'gte' | 'lte'; value: string | number }
  | { column: string; op: 'is_null' };

export interface PullCursor {
  /** Raw server `updated_at` of the last row seen (keeps microseconds). `null` = from the start. */
  updatedAt: string | null;
  /** Primary-key values of the last row seen, in `pk` order (tie-breaker). */
  key: (string | number)[] | null;
}

export interface PullRequest {
  table: string;
  /** Server column names to select. */
  select: string[];
  /** Server primary-key column names; `(updated_at, ...pk)` is the total order of the pull. */
  pk: string[];
  cursor: PullCursor;
  filters: PullFilter[];
  limit: number;
}

export interface PullResponse {
  /** Rows in `(updated_at, ...pk)` order, snake_case, tombstones included (`deleted_at` set). */
  rows: Record<string, unknown>[];
  /** Server time if the transport knows it (e.g. from the HTTP Date header). */
  serverTime?: string | null;
}

export interface PushItem {
  id: string;
  kind: string;
  payload: unknown;
  created_at: string;
}

export interface PushRequest {
  schema_version: number;
  device_id: string;
  items: PushItem[];
}

export interface PushRejection {
  id: string;
  code: 'invalid' | 'forbidden' | 'not_found' | 'stale' | string;
  drop: boolean;
}

export interface PushResponse {
  /** Processed, or already processed (idempotent). */
  acked: string[];
  rejected: PushRejection[];
  /** Authoritative card states for every card touched by the batch (snake_case rows). */
  card_states: Record<string, unknown>[];
  server_time: string;
}

export interface SyncTransport {
  push(req: PushRequest): Promise<PushResponse>;
  pull(req: PullRequest): Promise<PullResponse>;
}
