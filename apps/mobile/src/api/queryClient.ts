// TanStack Query client (mobile-app.md §3). Reads retry 3 times with exponential backoff, except
// for client errors. The query cache is persisted to MMKV so the last known server data shows
// immediately on a cold start.
import { QueryClient, dehydrate, hydrate, type DehydratedState, type Query } from '@tanstack/react-query';
import { getKv } from '../lib/kv';
import { ApiError } from './errors';

const retryReads = (failureCount: number, error: unknown): boolean => {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
    return false;
  }
  return failureCount < 3;
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: retryReads,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
      staleTime: 30_000,
    },
    mutations: { retry: 0 },
  },
});

/** Query keys (mobile-app.md §3). Always build keys here so invalidation stays consistent. */
export const queryKeys = {
  profile: () => ['profile'] as const,
  flags: () => ['flags'] as const,
  appVersions: () => ['appVersions'] as const,
  releaseNotes: () => ['releaseNotes'] as const,
  subject: (subjectId: string) => ['subject', subjectId] as const,
  subjectOutline: (subjectId: string) => ['subject', subjectId, 'outline'] as const,
  jobsForSubject: (subjectId: string) => ['jobs', subjectId] as const,
  job: (jobId: string) => ['job', jobId] as const,
  classGroups: () => ['classGroups'] as const,
  classGroup: (classGroupId: string) => ['classGroup', classGroupId] as const,
  classGroupInsights: (classGroupId: string) => ['classGroup', classGroupId, 'insights'] as const,
  duel: (duelId: string) => ['duel', duelId] as const,
  battle: (battleId: string) => ['battle', battleId] as const,
  tutorThreads: () => ['tutorThreads'] as const,
  tutorThread: (threadId: string) => ['tutorThread', threadId] as const,
  aiUsage: () => ['aiUsage'] as const,
};

// v1 wrote Maps/Sets as `{}`, which crashed screens that read them after a cold start.
const CACHE_KEY = 'rq.cache.v2';
const LEGACY_CACHE_KEYS = ['rq.cache.v1'];
const MAX_PERSISTED_BYTES = 1_000_000;

/** Some queries return Maps/Sets (mastery, outline index); plain JSON would flatten them to `{}`. */
export function serializeCache(state: DehydratedState): string {
  return JSON.stringify(state, (_key, value: unknown) => {
    if (value instanceof Map) return { __type: 'Map', entries: [...value] };
    if (value instanceof Set) return { __type: 'Set', values: [...value] };
    return value;
  });
}

export function deserializeCache(raw: string): DehydratedState {
  return JSON.parse(raw, (_key, value: unknown) => {
    if (value && typeof value === 'object' && '__type' in value) {
      const tagged = value as { __type: unknown; entries?: unknown; values?: unknown };
      if (tagged.__type === 'Map' && Array.isArray(tagged.entries)) return new Map(tagged.entries as [unknown, unknown][]);
      if (tagged.__type === 'Set' && Array.isArray(tagged.values)) return new Set(tagged.values);
    }
    return value;
  }) as DehydratedState;
}

function shouldPersist(query: Query): boolean {
  // Only server data that is safe to show offline; never errors or in-flight state.
  return query.state.status === 'success' && query.queryKey[0] !== 'job';
}

/**
 * Restores the persisted cache and keeps MMKV in sync (debounced). Returns a stop function.
 * Call once from the root layout, before the first screen queries.
 */
export function startQueryPersistence(): () => void {
  try {
    for (const key of LEGACY_CACHE_KEYS) getKv().remove(key);
    const raw = getKv().getString(CACHE_KEY);
    if (raw) hydrate(queryClient, deserializeCache(raw));
  } catch {
    getKv().remove(CACHE_KEY);
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const write = () => {
    timer = null;
    try {
      const state = dehydrate(queryClient, { shouldDehydrateQuery: shouldPersist });
      const serialized = serializeCache(state);
      if (serialized.length <= MAX_PERSISTED_BYTES) getKv().set(CACHE_KEY, serialized);
    } catch {
      // Persistence is best-effort.
    }
  };
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    if (timer === null) timer = setTimeout(write, 1000);
  });
  return () => {
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
  };
}
