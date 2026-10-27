// files.sweep (ai-pipeline §4.2, data-model R14): hourly. Deletes Files API objects whose 48-hour retention has
// passed and clears their ids, so no slice keeps a dead file reference. The upload job already deletes its
// files when it ends; this is the backstop for jobs that crashed in between.
import { sweepExpiredFiles, type FileRecord } from '@studify/ai';
import type { JobContext } from '../framework/types.ts';

export async function runFilesSweep(ctx: JobContext, nowMs: number): Promise<{ cleared: number; failed: number }> {
  const { rows } = await ctx.db.query<{ id: string; anthropic_file_id: string; anthropic_file_expires_at: Date }>(
    `select id, anthropic_file_id, anthropic_file_expires_at from public.document_slices
      where anthropic_file_id is not null order by anthropic_file_expires_at nulls first limit 500`,
  );
  const records: FileRecord[] = rows.map((r) => ({
    id: r.id,
    anthropic_file_id: r.anthropic_file_id,
    anthropic_file_expires_at: r.anthropic_file_expires_at ? new Date(r.anthropic_file_expires_at).toISOString() : null,
  }));
  const result = await sweepExpiredFiles(ctx.ai.client, records, nowMs);
  if (result.cleared.length > 0) {
    await ctx.db.query(
      `update public.document_slices set anthropic_file_id = null, anthropic_file_expires_at = null, updated_at = now()
        where id = any($1::uuid[])`,
      [result.cleared],
    );
  }
  for (const failure of result.failed) {
    ctx.log.warn({ sliceId: failure.sliceId }, 'files sweep: delete failed; retried next hour');
  }
  return { cleared: result.cleared.length, failed: result.failed.length };
}
