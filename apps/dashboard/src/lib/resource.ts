// Loads one API read and keeps it: revisiting a page shows the last answer at once while it refreshes, and a
// refresh keeps the old data on screen (no flash of empty content).
import { useCallback, useEffect, useRef, useState } from 'react';

const cache = new Map<string, unknown>();

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  /** Replaces the data with a fresher answer (control calls answer the updated read model). */
  set: (value: T) => void;
}

export function useResource<T>(key: string | null, load: () => Promise<T>): Resource<T> {
  const [data, setData] = useState<T | undefined>(() => (key ? (cache.get(key) as T | undefined) : undefined));
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(key !== null);
  const loader = useRef(load);
  loader.current = load;
  const latest = useRef(0);

  const reload = useCallback(async () => {
    if (!key) return;
    const ticket = ++latest.current;
    setLoading(true);
    try {
      const value = await loader.current();
      if (ticket !== latest.current) return;
      cache.set(key, value);
      setData(value);
      setError(null);
    } catch (e) {
      if (ticket === latest.current) setError(e);
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    if (!key) return;
    setData(cache.get(key) as T | undefined);
    void reload();
  }, [key, reload]);

  const set = useCallback(
    (value: T) => {
      if (key) cache.set(key, value);
      setData(value);
    },
    [key],
  );

  return { data, error, loading, reload, set };
}

export function clearResources(): void {
  cache.clear();
}
