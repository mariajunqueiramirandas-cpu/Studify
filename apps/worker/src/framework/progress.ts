// Mirrors pg-boss job state into ai_jobs, the user-visible progress row (api.md §7, data-model
// ai_jobs). Realtime broadcasts the row changes to the app. Only the fields a caller passes change.
import type { Sql } from './db.ts';
import { messageKeyFor } from './errors.ts';

export interface ProgressPatch {
  stage?: string;
  status?: string;
  progress?: number;
  items_total?: number;
  items_done?: number;
  batch_id?: string | null;
  attempts?: number;
  error_code?: string | null;
  error_message_key?: string | null;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** Told about every applied patch (the runtime turns stage changes into live notifications, notify.live). */
export type ProgressListener = (aiJobId: string, patch: ProgressPatch) => void;
let listener: ProgressListener | null = null;

export function setProgressListener(fn: ProgressListener | null): void {
  listener = fn;
}

export function isTerminalStatus(status: string | undefined): boolean {
  return status !== undefined && TERMINAL.has(status);
}

/**
 * Applies a patch to ai_jobs. `progress` is derived from items when only the counts change.
 * Sets started_at on the first running state and finished_at on a terminal state.
 */
export async function applyProgress(sql: Sql, aiJobId: string, patch: ProgressPatch): Promise<void> {
  const sets: string[] = ['updated_at = now()'];
  const values: unknown[] = [aiJobId];
  const add = (column: string, value: unknown, cast = '') => {
    values.push(value);
    sets.push(`${column} = $${values.length}${cast}`);
  };

  let progress = patch.progress;
  if (progress === undefined && patch.items_total !== undefined && patch.items_done !== undefined && patch.items_total > 0) {
    progress = Math.min(1, Math.max(0, patch.items_done / patch.items_total));
  }
  if (patch.stage !== undefined) add('stage', patch.stage);
  if (patch.status !== undefined) add('status', patch.status);
  if (progress !== undefined) add('progress', Math.min(1, Math.max(0, progress)));
  if (patch.items_total !== undefined) add('items_total', Math.max(0, Math.floor(patch.items_total)));
  if (patch.items_done !== undefined) add('items_done', Math.max(0, Math.floor(patch.items_done)));
  if (patch.batch_id !== undefined) add('batch_id', patch.batch_id);
  if (patch.attempts !== undefined) add('attempts', patch.attempts);
  if (patch.error_code !== undefined) add('error_code', patch.error_code);
  if (patch.error_message_key !== undefined) add('error_message_key', patch.error_message_key);
  if (patch.status === 'failed' && patch.error_message_key === undefined && patch.error_code) {
    add('error_message_key', messageKeyFor(patch.error_code));
  }
  if (patch.status === 'running') sets.push('started_at = coalesce(started_at, now())');
  if (patch.status && TERMINAL.has(patch.status)) sets.push('finished_at = now()');
  if (sets.length === 1) return;
  await sql.query(`update public.ai_jobs set ${sets.join(', ')} where id = $1`, values);
  if (listener && (patch.stage !== undefined || patch.status !== undefined || progress !== undefined)) {
    try {
      listener(aiJobId, patch);
    } catch {
      // A notification problem never fails the job.
    }
  }
}

/**
 * Returns the ai_jobs row for a pg-boss job, creating it on the first attempt. The pg-boss job id is
 * stable across retries, so a retried job finds the same row.
 */
export async function ensureAiJob(
  sql: Sql,
  input: { pgbossJobId: string; type: string; userId: string | null; subjectId: string | null; documentId: string | null },
): Promise<string> {
  const found = await sql.query<{ id: string }>(
    `select id from public.ai_jobs where pgboss_job_id = $1 limit 1`,
    [input.pgbossJobId],
  );
  const existing = found.rows[0]?.id;
  if (existing) return existing;
  const inserted = await sql.query<{ id: string }>(
    `insert into public.ai_jobs (type, user_id, subject_id, document_id, pgboss_job_id, status)
     values ($1, $2, $3, $4, $5, 'queued') returning id`,
    [input.type, input.userId, input.subjectId, input.documentId, input.pgbossJobId],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error('ai_jobs insert returned no id');
  return id;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
