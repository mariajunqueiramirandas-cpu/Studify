// Feature flags: the union of `profiles.settings.flags` (opt-ins, local) and the server's
// `my_feature_flags()` RPC via the flags-mine endpoint (rollouts from the feature_flags table). Cached in MMKV so flags work
// offline and on the first frame.
import { useSyncExternalStore } from 'react';
import type { AppDb } from '../db/client';
import { profiles } from '../db/schema';
import { getKv } from './kv';
import { isNotEmptyString } from './guards';

const CACHE_KEY = 'flags.cache.v1';

let current: ReadonlySet<string> = readCache();
const listeners = new Set<() => void>();

function readCache(): ReadonlySet<string> {
  try {
    const raw = getKv().getString(CACHE_KEY);
    if (!raw) return new Set();
    const list = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(list) ? list.filter(isNotEmptyString) : []);
  } catch {
    return new Set();
  }
}

function publish(next: ReadonlySet<string>): void {
  current = next;
  try {
    getKv().set(CACHE_KEY, JSON.stringify([...next].sort()));
  } catch {
    // cache is best-effort
  }
  for (const listener of listeners) listener();
}

/** Flags currently enabled for this user (cached). */
export function getFeatureFlags(): ReadonlySet<string> {
  return current;
}

export function isFeatureEnabled(key: string): boolean {
  return current.has(key);
}

/** Merges local opt-ins (profile settings) with the server's eligible flags, and caches the result. */
export async function refreshFeatureFlags(db: AppDb, serverFlags?: string[]): Promise<ReadonlySet<string>> {
  const local = db.select({ settings: profiles.settings }).from(profiles).limit(1).get()?.settings as
    | { flags?: unknown }
    | undefined;
  const localFlags = Array.isArray(local?.flags) ? local.flags.filter(isNotEmptyString) : [];
  const remote = serverFlags ?? (await fetchServerFlags());
  const next = new Set<string>([...localFlags, ...remote]);
  publish(next);
  return next;
}

async function fetchServerFlags(): Promise<string[]> {
  // Imported lazily: the flags module must stay importable without the API client configured.
  const { data } = await import('../api/data');
  const flags = await data<unknown>('flags-mine');
  return Array.isArray(flags) ? (flags as unknown[]).filter(isNotEmptyString) : [];
}

/** Re-renders when the flag set changes. */
export function useFeatureFlag(key: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => current.has(key),
    () => false,
  );
}
