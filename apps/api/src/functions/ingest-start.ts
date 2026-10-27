// ingest-start (ING-01…03, PLT-04.4). Called after the PDF is in Storage and the documents row exists.
// Checks: the caller may upload to the subject, the file is there, size and page limits, no duplicate
// checksum in the subject, at most 3 jobs in flight. The budget is pre-checked for the full run and,
// when that does not fit, for the outline only (PLT-04.4). The worker reserves again per Claude call.
import type { z } from 'zod';
import { ApiFailure, IngestStartReqSchema, } from '@studify/shared';
import type { IngestStartRes } from '../_shared/responses.ts';
import { DEFAULT_MODEL, costMicroUsd, zeroUsage } from '@studify/ai';
import { defineFunction } from '../_shared/http.ts';
import { requireSubject } from '../_shared/access.ts';
import { objectExists } from '../_shared/storage.ts';
import { activeJobCount, createAiJob } from '../_shared/jobs.ts';
import { BudgetExceededError } from '@studify/ai';
import type { Deps } from '../_shared/deps.ts';

export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_PAGES = 1000;
const TOKENS_PER_PAGE = 2000;
const OUTLINE_MAX_PAGES = 150;
const MAX_CONCURRENT_JOBS = 3;

/** Pre-check estimate in micro-USD (ai-pipeline §9.5 order of magnitude; replaced by §9.4 data). */
export function estimateFullMicroUsd(pages: number): number {
  return costMicroUsd({ ...zeroUsage(), input_tokens: pages * TOKENS_PER_PAGE, output_tokens: 5_000 + pages * 400 }, { model: DEFAULT_MODEL });
}

export function estimateOutlineMicroUsd(pages: number): number {
  return costMicroUsd(
    { ...zeroUsage(), input_tokens: Math.min(pages, OUTLINE_MAX_PAGES) * TOKENS_PER_PAGE, output_tokens: 5_000 },
    { model: DEFAULT_MODEL },
  );
}

/** Reserves and immediately releases a hold: the pre-check. Throws BudgetExceededError when refused. */
async function precheck(deps: Deps, ctx: { userId: string; classGroupId: string | null; documentId: string }, micro: number) {
  const reservation = await deps.ai.budget.reserve({
    ctx: {
      userId: ctx.userId,
      classGroupId: ctx.classGroupId,
      documentId: ctx.documentId,
      feature: 'ING-01',
      budgetClass: 'content',
    },
    taskId: 'ingest.outline',
    promptVersion: 'precheck',
    estimateMicroUsd: micro,
    mode: 'sync',
  });
  if (!reservation.ok) throw new BudgetExceededError(reservation.scope, reservation.resetsAt);
  await deps.ai.budget.settle(reservation.reservationId, 0);
}

export const handler = defineFunction<z.infer<typeof IngestStartReqSchema>>({
  name: 'ingest-start',
  mutating: true,
  aiCall: true,
  input: IngestStartReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    const doc = await deps.db.from('documents').select('*').eq('id', input.document_id).is('deleted_at', null).maybeSingle();
    if (doc.error) throw doc.error;
    if (!doc.data) throw new ApiFailure('not_found');
    const subject = await requireSubject(deps.db, userId, doc.data.subject_id as string, 'upload');

    if (!['uploaded', 'failed', 'waiting_budget'].includes(doc.data.status as string)) {
      throw new ApiFailure('already_exists', { message: 'Esse material já está sendo lido ou já ficou pronto.' });
    }
    if (!(await objectExists(deps.db, doc.data.storage_path as string))) {
      throw new ApiFailure('not_found', { message: 'O arquivo não chegou no servidor. Tenta enviar de novo.' });
    }
    if (Number(doc.data.size_bytes) > MAX_BYTES) throw new ApiFailure('file_too_large');
    const knownPages = (doc.data.page_count as number | null) ?? 0;
    if (knownPages > MAX_PAGES) throw new ApiFailure('too_many_pages');

    const duplicate = await deps.db
      .from('documents')
      .select('id')
      .eq('subject_id', subject.id)
      .eq('checksum_sha256', doc.data.checksum_sha256 as string)
      .neq('id', doc.data.id as string)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    if (duplicate.error) throw duplicate.error;
    if (duplicate.data) {
      throw new ApiFailure('duplicate_document', { details: { existing_document_id: duplicate.data.id as string } });
    }

    if ((await activeJobCount(deps, userId)) >= MAX_CONCURRENT_JOBS) throw new ApiFailure('rate_limited');

    const pages = knownPages;
    const scope = { userId, classGroupId: subject.owner_class_group_id, documentId: doc.data.id as string };
    let mode: 'full' | 'outline_only' = input.mode ?? 'full';
    let budgetNote: 'outline_only_today' | undefined;
    if (mode === 'full') {
      try {
        await precheck(deps, scope, estimateFullMicroUsd(pages));
      } catch (err) {
        if (!(err instanceof BudgetExceededError)) throw err;
        // PLT-04.4: the outline still fits today, so the rest waits for tomorrow.
        await precheck(deps, scope, estimateOutlineMicroUsd(pages));
        mode = 'outline_only';
        budgetNote = 'outline_only_today';
      }
    } else {
      await precheck(deps, scope, estimateOutlineMicroUsd(pages));
    }

    const jobId = await createAiJob(deps, { type: 'ingest.document', userId, subjectId: subject.id, documentId: doc.data.id as string, stage: 'S0' });
    const updated = await deps.db.from('documents').update({ status: 'processing', error_code: null }).eq('id', doc.data.id as string);
    if (updated.error) throw updated.error;
    await deps.enqueue('ingest.document', { document_id: doc.data.id, mode, job_id: jobId }, { singletonKey: doc.data.id as string, retryLimit: 3 });

    const body: IngestStartRes = {
      job_id: jobId,
      estimated_pages: pages,
      mode,
      ...(budgetNote ? { budget_note: budgetNote } : {}),
    };
    return ctx.json(body, 202);
  },
});

export default handler;

// Entry point: serves the function when this file is the main module. Tests import `handler` only.
if (import.meta.main) {
  const { prodDeps } = await import('../_shared/prod.ts');
  Deno.serve((req) => handler(req, prodDeps()));
}
