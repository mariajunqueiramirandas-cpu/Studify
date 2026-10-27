// Live queries: re-run a synchronous Drizzle read whenever a relevant table changes.
// expo-sqlite emits change events per table (enableChangeListener in client.ts). Bursts of writes
// (a pull page, an ack batch) are coalesced into one re-read.
import { useEffect, useReducer, useRef } from 'react';
import { addDatabaseChangeListener } from 'expo-sqlite';
import type { AppDb } from '../client';
import { useDb } from '../DatabaseProvider';

export interface LiveState<T> {
  data: T | undefined;
  error: Error | undefined;
  /** Bumped on every re-read. */
  updatedAt: number;
}

export interface UseLiveOptions {
  /** Tables whose changes re-run the query. Omit to re-run on any change (use sparingly). */
  tables?: readonly string[];
  /** Extra dependencies that change the query (ids, filters). */
  deps?: readonly unknown[];
  /** Skip the query (returns `data: undefined`). */
  enabled?: boolean;
}

const COALESCE_MS = 16;

/**
 * Runs `read(db)` now and on every change to `options.tables`.
 *
 * @example
 *   const { data } = useLive((db) => db.select().from(subjects).all(), { tables: ['subjects'] });
 */
export function useLive<T>(read: (db: AppDb) => T, options: UseLiveOptions = {}): LiveState<T> {
  const db = useDb();
  const enabled = options.enabled ?? true;
  const readRef = useRef(read);
  readRef.current = read;

  const [state, setState] = useReducer(
    (_: LiveState<T>, next: LiveState<T>) => next,
    { data: undefined, error: undefined, updatedAt: 0 } as LiveState<T>,
  );

  const tablesKey = options.tables ? options.tables.join('|') : '*';
  const depsKey = JSON.stringify(options.deps ?? []);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const run = () => {
      timer = null;
      if (disposed) return;
      try {
        const data = readRef.current(db);
        setState({ data, error: undefined, updatedAt: Date.now() });
      } catch (cause) {
        setState({
          data: undefined,
          error: cause instanceof Error ? cause : new Error(String(cause)),
          updatedAt: Date.now(),
        });
      }
    };
    const schedule = () => {
      if (timer === null) timer = setTimeout(run, COALESCE_MS);
    };

    run();
    const tables = options.tables ? new Set(options.tables) : null;
    const subscription = addDatabaseChangeListener(({ tableName }) => {
      if (!tables || tables.has(tableName)) schedule();
    });

    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      subscription.remove();
    };
    // The query identity is expressed through `deps`; the read callback is kept in a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, enabled, tablesKey, depsKey]);

  return state;
}
