// ingest-retry (ING-01). Restarts a failed or budget-blocked document, or one topic whose content failed.
import type { z } from 'zod';
import { ApiFailure, IngestRetryReqSchema, } from '@studify/shared';
import type { IngestRetryRes } from '../_shared/responses.ts';
import { defineFunction } from '../_shared/http.ts';
import { requireSubject } from '../_shared/access.ts';
import { createAiJob } from '../_shared/jobs.ts';

export const handler = defineFunction<z.infer<typeof IngestRetryReqSchema>>({
  name: 'ingest-retry',
  mutating: true,
  input: IngestRetryReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const doc = await deps.db.from('documents').select('id, subject_id, status').eq('id', input.document_id).is('deleted_at', null).maybeSingle();
    if (doc.error) throw doc.error;
    if (!doc.data) throw new ApiFailure('not_found');
    const subject = await requireSubject(deps.db, ctx.user.userId, doc.data.subject_id as string, 'upload');

    let retryable = ['failed', 'waiting_budget'].includes(doc.data.status as string);
    if (!retryable) {
      const failedTopic = await deps.db
        .from('knowledge_nodes')
        .select('id')
        .eq('origin_document_id', doc.data.id as string)
        .eq('content_status', 'failed')
        .limit(1)
        .maybeSingle();
      if (failedTopic.error) throw failedTopic.error;
      retryable = failedTopic.data !== null;
    }
    if (!retryable) throw new ApiFailure('already_exists', { message: 'Não tem nada pra tentar de novo nesse material.' });

    const jobId = await createAiJob(deps, {
      type: 'ingest.document',
      userId: ctx.user.userId,
      subjectId: subject.id,
      documentId: doc.data.id as string,
      stage: input.from_stage ?? 'S0',
    });
    const updated = await deps.db.from('documents').update({ status: 'processing', error_code: null }).eq('id', doc.data.id as string);
    if (updated.error) throw updated.error;
    await deps.enqueue(
      'ingest.document',
      { document_id: doc.data.id, mode: 'full', from_stage: input.from_stage ?? 'S0', job_id: jobId },
      { singletonKey: doc.data.id as string, retryLimit: 3 },
    );
    const body: IngestRetryRes = { job_id: jobId };
    return ctx.json(body, 202);
  },
});

export default handler;

// Entry point: serves the function when this file is the main module. Tests import `handler` only.
if (import.meta.main) {
  const { prodDeps } = await import('../_shared/prod.ts');
  Deno.serve((req) => handler(req, prodDeps()));
}
