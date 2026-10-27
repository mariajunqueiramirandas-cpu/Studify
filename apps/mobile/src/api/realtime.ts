// Realtime helpers (data-model §8, api.md §8). Postgres changes on `ai_jobs` are written into the
// TanStack cache under ['job', jobId], so screens read one source of truth.
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryClient, queryKeys } from './queryClient';
import { supabase } from './supabase';

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
  const channel = supabase
    .channel(`job:${jobId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'ai_jobs', filter: `id=eq.${jobId}` },
      (payload: { new: Partial<AiJobRow> }) => {
        const row = payload.new as AiJobRow;
        queryClient.setQueryData<AiJobRow>(queryKeys.job(jobId), (prev) => ({ ...(prev as AiJobRow), ...row }));
        onUpdate?.(row);
      },
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

async function fetchJob(jobId: string): Promise<AiJobRow> {
  const { data, error } = await supabase.from('ai_jobs').select('*').eq('id', jobId).single();
  if (error) throw error;
  return data as AiJobRow;
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
