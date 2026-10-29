// Realtime (data-model §8, api.md §8): the app's one SSE stream to the API (realtime-client.ts), and the job helpers.
// Changes of an `ai_jobs` row are written into the TanStack cache under ['job', jobId], so screens read one source
// of truth.
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetch } from 'expo/fetch';
import { data } from './data';
import { authHeaders, callFunction } from './functions';
import { getApiUrl } from './env';
import { queryClient, queryKeys } from './queryClient';
import { RealtimeClient, rowTopic, type RowChange } from './realtime-client';
import { supabase } from './supabase';

export { rowTopic, type RealtimeChannel, type RowChange } from './realtime-client';

/** The app's realtime connection: one SSE stream, opened while any channel is subscribed. */
export const realtime = new RealtimeClient({
  open: async (signal) =>
    fetch(`${getApiUrl()}/realtime-stream`, { method: 'POST', headers: await authHeaders(null), body: '{}', signal }) as unknown as Response,
  call: (name, body) => callFunction(name, body),
  refresh: async () => {
    await supabase.auth.refreshSession();
  },
});

export interface AiJobRow {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'waiting_batch' | 'waiting_budget' | 'succeeded' | 'failed' | 'cancelled';
  stage: string | null;
  progress: number;
  items_total: number | null;
  items_done: number | null;
  error_code: string | null;
  error_message_key: string | null;
  [column: string]: unknown;
}

/**
 * Subscribes to one job's row changes. Each change is merged into ['job', jobId].
 * Returns the unsubscribe function.
 */
export function subscribeJobProgress(jobId: string, onUpdate?: (row: AiJobRow) => void): () => void {
  const channel = realtime
    .channel(rowTopic('ai_jobs', 'id', jobId))
    .on('change', (change: RowChange<AiJobRow>) => {
      const row = change.new;
      if (!row) return;
      queryClient.setQueryData<AiJobRow>(queryKeys.job(jobId), (prev) => ({ ...(prev as AiJobRow), ...row }));
      onUpdate?.(row);
    })
    .subscribe();
  return () => {
    void realtime.removeChannel(channel);
  };
}

async function fetchJob(jobId: string): Promise<AiJobRow> {
  const row = await data<AiJobRow | null>('jobs-get', { job_id: jobId });
  if (!row) throw new Error('job not found');
  return row;
}

/** The ai_jobs row for a job, kept fresh by Realtime. `data` is the row once loaded. */
export function useJob(jobId: string | null | undefined) {
  const query = useQuery({
    queryKey: queryKeys.job(jobId ?? 'none'),
    queryFn: () => fetchJob(jobId as string),
    enabled: !!jobId,
  });
  useEffect(() => {
    if (!jobId) return undefined;
    return subscribeJobProgress(jobId);
  }, [jobId]);
  return query;
}
