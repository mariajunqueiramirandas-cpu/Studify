// Live progress while the app is open (api.md §9.1): the student's running jobs are mirrored into the same
// Live Update the server pushes (same key and payload, from packages/shared), so it appears the moment a
// material is sent and keeps going if the app is put away. When the app sees a material finish first, it
// shows the final "Material pronto" itself: without a Firebase project that is the only way it arrives.
// Realtime on the student's ai_jobs rows wakes the query; it polls every 5 s only while a job is running.
import { isLiveJobType, liveKeyOf, liveRich, materialDoneRich, type LiveJobRow } from '@studify/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { eq } from 'drizzle-orm';
import { useEffect, useRef } from 'react';
import { realtime, rowTopic, type RowChange } from '../../api/realtime';
import { supabase } from '../../api/supabase';
import { useDb } from '../../db/DatabaseProvider';
import { subjects } from '../../db/schema';
import { richNotifier } from '../../platform/rich-notify';
import { useSession } from '../auth/session';
import { mergeJobRow, type AiJob } from '../subjects/api';

const ACTIVE = ['queued', 'running', 'waiting_batch', 'waiting_budget'];

export function useLiveJobs() {
  const { userId } = useSession();
  const db = useDb();
  const qc = useQueryClient();
  const tracked = useRef(new Map<string, LiveJobRow>());
  useEffect(() => {
    if (!userId) return undefined;
    const channel = realtime
      .channel(rowTopic('ai_jobs', 'user_id', userId))
      .on('change', (payload: RowChange<Partial<AiJob>>) => {
        // The new row goes straight into the screens' caches: progress shows the moment the server writes it.
        if (payload.new?.id) mergeJobRow(qc, payload.new as Partial<AiJob> & { id: string });
        void qc.invalidateQueries({ queryKey: ['liveJobs', userId] });
      })
      .subscribe();
    return () => {
      void realtime.removeChannel(channel);
    };
  }, [userId, qc]);
  const query = useQuery({
    queryKey: ['liveJobs', userId],
    enabled: !!userId,
    queryFn: async (): Promise<LiveJobRow[]> => {
      const since = new Date(Date.now() - 6 * 3600_000).toISOString();
      const { data } = await supabase
        .from('ai_jobs')
        .select('id,type,stage,status,progress,user_id,subject_id,document_id,started_at,items_total,items_done')
        .eq('user_id', userId!)
        .is('parent_job_id', null)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(10);
      return ((data ?? []) as LiveJobRow[]).filter((j) => isLiveJobType(j.type));
    },
    refetchInterval: (q) => ((q.state.data ?? []).some((j) => ACTIVE.includes(j.status)) || tracked.current.size > 0 ? 5000 : false),
  });

  useEffect(() => {
    const jobs = query.data ?? [];
    const subjectOf = (id: string | null) => (id ? (db.select({ name: subjects.name, color: subjects.color }).from(subjects).where(eq(subjects.id, id)).get() ?? null) : null);
    for (const job of jobs) {
      const key = liveKeyOf(job);
      if (ACTIVE.includes(job.status)) {
        const rich = liveRich(job, subjectOf(job.subject_id));
        if (rich) void richNotifier.show(rich);
        tracked.current.set(job.id, job);
        continue;
      }
      // Only jobs this session watched end here; older finished jobs are left alone.
      if (!tracked.current.has(job.id)) continue;
      tracked.current.delete(job.id);
      if (job.type === 'ingest.document' && job.document_id && job.subject_id) {
        const done = materialDoneRich({ documentId: job.document_id, subjectId: job.subject_id, subject: subjectOf(job.subject_id), failed: job.status !== 'succeeded', stage: job.stage });
        if (done) void richNotifier.show(done);
      } else {
        richNotifier.cancel(key);
      }
    }
  }, [query.data, db]);
}
