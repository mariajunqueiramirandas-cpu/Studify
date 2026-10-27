// Non-visual provider: opens the database, runs migrations, then renders `children`.
// Until then it renders `fallback` (nothing by default). Mount it once, high in the root layout.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ensureAppDatabase, type AppDb } from './client';

export type DatabaseState =
  | { status: 'loading'; db: null; error: null }
  | { status: 'ready'; db: AppDb; error: null }
  | { status: 'error'; db: null; error: Error };

const DatabaseContext = createContext<DatabaseState>({ status: 'loading', db: null, error: null });

export interface DatabaseProviderProps {
  children: ReactNode;
  /** Rendered while migrations run or if they failed. Defaults to nothing. */
  fallback?: ReactNode;
  /** Called once the database is ready (e.g. to start the sync controller). */
  onReady?: (db: AppDb) => void;
  /** Called when opening or migrating fails (log it, show the UI error state). */
  onError?: (error: Error) => void;
}

export function DatabaseProvider({ children, fallback = null, onReady, onError }: DatabaseProviderProps) {
  const [state, setState] = useState<DatabaseState>({ status: 'loading', db: null, error: null });

  useEffect(() => {
    let cancelled = false;
    ensureAppDatabase()
      .then((db) => {
        if (cancelled) return;
        setState({ status: 'ready', db, error: null });
        onReady?.(db);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        setState({ status: 'error', db: null, error });
        onError?.(error);
      });
    return () => {
      cancelled = true;
    };
    // onReady/onError are wiring callbacks; the database is opened exactly once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <DatabaseContext.Provider value={state}>
      {state.status === 'ready' ? children : fallback}
    </DatabaseContext.Provider>
  );
}

/** The ready database. Throws outside a ready <DatabaseProvider>. */
export function useAppDb(): AppDb {
  const state = useContext(DatabaseContext);
  if (state.status !== 'ready') {
    throw new Error('useAppDb() called before the database is ready. Render it inside <DatabaseProvider>.');
  }
  return state.db;
}

/** Alias of useAppDb(): the drizzle database of the ready provider. */
export const useDb = useAppDb;

/** Loading / error / ready state, for screens that want to show a database error message. */
export function useDatabaseState(): DatabaseState {
  return useContext(DatabaseContext);
}
