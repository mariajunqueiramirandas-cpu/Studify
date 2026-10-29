// A server job as the screens show it (GenerationStatus): its step, how much is done, when it started, and how it
// ended. Rows come from the subject's jobs, which Realtime keeps current (mergeJobRow), so a screen reopened in the
// middle of a generation finds it again and follows it.
import { isLiveJobType, liveJobProgress } from '@studify/shared';
import { useQuery } from '@tanstack/react-query';
import { useJob } from '../../api/realtime';
import { data } from '../../api/data';
import { t } from '../../i18n';
import { useSession } from '../auth/session';
import { useSubjectJobs, type AiJob } from '../subjects/api';

const ACTIVE = new Set(['queued', 'running', 'waiting_batch', 'waiting_budget']);

export interface JobView {
  active: boolean;
  failed: boolean;
  succeeded: boolean;
  queued: boolean;
  /** The step it is on ("Questões"), when the job type has steps. */
  detail: string | null;
  /** Share done, when the server reports it (a single long call reports none: the bar glides instead). */
  fraction: number | null;
  startedAt: string | null;
  /** What went wrong, for a failed job. */
  error: string | null;
}

/** The PT-BR failure of a job: the budget, or that the generation did not work. */
export function jobErrorText(job: Pick<AiJob, 'error_code'>): string {
  if (job.error_code === 'budget_exhausted' || job.error_code === 'budget_exceeded' || job.error_code === 'class_budget_exhausted') return t('budget.user_daily');
  if (job.error_code === 'interrupted') return t('wait.interrupted');
  return t('error.generation');
}

export function jobView(job: AiJob | undefined): JobView | null {
  if (!job) return null;
  const active = ACTIVE.has(job.status);
  const failed = job.status === 'failed' || job.status === 'cancelled';
  const progress = isLiveJobType(job.type) ? liveJobProgress(job.type, job.stage, job.status, job.progress) : null;
  return {
    active,
    failed,
    succeeded: job.status === 'succeeded',
    queued: job.status === 'queued',
    detail: progress?.steps.find((s) => s.state === 'active')?.label ?? null,
    fraction: progress && active && job.status !== 'queued' && (job.progress ?? 0) > 0 ? progress.fraction : null,
    startedAt: job.started_at ?? job.created_at,
    error: failed ? jobErrorText(job) : null,
  };
}

/**
 * The newest job of `type` for the subject (a generation started from this screen or before it was opened); with
 * `since`, only one created around then (the job of this episode, not an older one).
 */
export function useLatestJob(subjectId: string | undefined, type: string, since?: string | null): AiJob | undefined {
  const jobs = useSubjectJobs(subjectId);
  const from = since ? Date.parse(since) - 60_000 : null;
  return jobs.data?.find((j) => j.type === type && (from === null || Date.parse(j.created_at) >= from));
}

/**
 * The student's job of `type` for work outside a subject (an ENEM redação), followed live: `jobId` when the screen
 * started it, else the newest one created around `since` (when the work was marked as started).
 */
export function useOwnJob(type: string, since: string | null | undefined, jobId?: string | null): AiJob | undefined {
  const { userId } = useSession();
  const found = useQuery({
    queryKey: ['ownJob', type, since ?? null],
    enabled: !jobId && !!userId && !!since,
    queryFn: async () => (await data<{ id: string | null }>('jobs-latest', { type, since })).id,
  });
  return useJob(jobId ?? found.data ?? null).data as AiJob | undefined;
}
