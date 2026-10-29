// Persistent progress/read model for long domain operations. Execution is direct, not driven by these rows.
import type { Deps } from './deps.ts';

export interface NewJob {
  type: string;
  userId: string;
  subjectId?: string | null;
  documentId?: string | null;
  stage?: string | null;
}

export async function createAiJob(deps: Deps, job: NewJob): Promise<string> {
  const id = deps.newId();
  const { error } = await deps.db.from('ai_jobs').insert({
    id,
    type: job.type,
    user_id: job.userId,
    subject_id: job.subjectId ?? null,
    document_id: job.documentId ?? null,
    stage: job.stage ?? null,
    status: 'queued',
  });
  if (error) throw error;
  return id;
}

/** Counts jobs the user has in flight (api §2.5: 3 concurrent heavy jobs per user). */
export async function activeJobCount(deps: Deps, userId: string): Promise<number> {
  const { count, error } = await deps.db
    .from('ai_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('status', ['queued', 'running', 'waiting_batch', 'waiting_budget']);
  if (error) throw error;
  return count ?? 0;
}
