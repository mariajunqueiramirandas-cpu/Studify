// ingest-start (ING-01…03, PLT-04.4). Called after the app put the PDF in Storage. The server creates the
// documents row (the app never writes it) unless it already exists (a retry).
// Checks: the caller may upload to the subject, the file is there, size and page limits, no duplicate
// checksum in the subject, at most 3 jobs in flight. The budget is pre-checked for the full run and,
// when that does not fit, for the outline only (PLT-04.4). The worker reserves again per Claude call.
import type { z } from 'zod';
import { ApiFailure, IngestStartReqSchema, } from '@studify/shared';
import type { IngestStartRes } from '../shared/responses.ts';
import { DEFAULT_MODEL, costMicroUsd, zeroUsage } from '@studify/ai';
import { defineFunction } from '../shared/http.ts';
import { requireSubject } from '../shared/access.ts';
import { documentObjectPath, downloadBytes, objectExists } from '../shared/storage.ts';
import { activeJobCount, createAiJob } from '../shared/jobs.ts';
import { BudgetExceededError } from '@studify/ai';
import { inBackground, type Deps } from '../shared/deps.ts';

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

type IngestStartInput = z.infer<typeof IngestStartReqSchema>;

const NOT_A_PDF = 'Esse arquivo não é um PDF.';

/**
 * Creates the documents row for a PDF the app uploaded to `documents/{subject_id}/{document_id}.pdf`. Size,
 * checksum and the PDF header come from the stored file, not from the client. A rejected file is removed
 * from Storage, since no row will ever point at it.
 */
async function createDocument(deps: Deps, userId: string, input: IngestStartInput & { subject_id: string }): Promise<Record<string, unknown>> {
  const subject = await requireSubject(deps.db, userId, input.subject_id, 'upload');
  const storagePath = `${subject.id}/${input.document_id}.pdf`;
  const objectPath = documentObjectPath(storagePath);
  if (!(await objectExists(deps.db, objectPath))) {
    throw new ApiFailure('not_found', { message: 'O arquivo não chegou no servidor. Tenta enviar de novo.' });
  }
  const discard = async () => {
    await deps.db.storage.from('documents').remove([storagePath]);
  };
  const bytes = await downloadBytes(deps.db, objectPath);
  if (bytes.byteLength > MAX_BYTES) {
    await discard();
    throw new ApiFailure('file_too_large');
  }
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
    await discard();
    throw new ApiFailure('pdf_corrupt', { message: NOT_A_PDF });
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  const checksum = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');

  const duplicate = await deps.db
    .from('documents')
    .select('id')
    .eq('subject_id', subject.id)
    .eq('checksum_sha256', checksum)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle();
  if (duplicate.error) throw duplicate.error;
  if (duplicate.data) {
    await discard();
    throw new ApiFailure('duplicate_document', { details: { existing_document_id: duplicate.data.id as string } });
  }

  const kind = input.kind ?? 'other';
  const row: Record<string, unknown> = {
    id: input.document_id,
    subject_id: subject.id,
    uploaded_by: userId,
    title: input.title ?? 'Material',
    kind,
    storage_path: storagePath,
    mime_type: 'application/pdf',
    size_bytes: bytes.byteLength,
    checksum_sha256: checksum,
    teacher_name: kind === 'past_test' ? input.teacher_name || null : null,
    status: 'uploaded',
    page_count: null,
    deleted_at: null,
  };
  const inserted = await deps.db.from('documents').insert(row);
  if (inserted.error) {
    // 23505: the same file landed in this subject concurrently (unique checksum per subject).
    if (inserted.error.code === '23505') throw new ApiFailure('duplicate_document');
    throw inserted.error;
  }
  return row;
}

export const handler = defineFunction<z.infer<typeof IngestStartReqSchema>>({
  name: 'ingest-start',
  mutating: true,
  aiCall: true,
  input: IngestStartReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    const found = await deps.db.from('documents').select('*').eq('id', input.document_id).maybeSingle();
    if (found.error) throw found.error;
    if (found.data?.deleted_at) throw new ApiFailure('not_found');
    let doc = found.data as Record<string, unknown> | null;
    if (!doc) {
      if (!input.subject_id) throw new ApiFailure('not_found');
      doc = await createDocument(deps, userId, { ...input, subject_id: input.subject_id });
    }
    const subject = await requireSubject(deps.db, userId, doc.subject_id as string, 'upload');

    if (!['uploaded', 'failed', 'waiting_budget'].includes(doc.status as string)) {
      throw new ApiFailure('already_exists', { message: 'Esse material já está sendo lido ou já ficou pronto.' });
    }
    if (!(await objectExists(deps.db, documentObjectPath(doc.storage_path as string)))) {
      throw new ApiFailure('not_found', { message: 'O arquivo não chegou no servidor. Tenta enviar de novo.' });
    }
    if (Number(doc.size_bytes) > MAX_BYTES) throw new ApiFailure('file_too_large');
    const knownPages = (doc.page_count as number | null) ?? 0;
    if (knownPages > MAX_PAGES) throw new ApiFailure('too_many_pages');

    const duplicate = await deps.db
      .from('documents')
      .select('id')
      .eq('subject_id', subject.id)
      .eq('checksum_sha256', doc.checksum_sha256 as string)
      .neq('id', doc.id as string)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    if (duplicate.error) throw duplicate.error;
    if (duplicate.data) {
      throw new ApiFailure('duplicate_document', { details: { existing_document_id: duplicate.data.id as string } });
    }

    if ((await activeJobCount(deps, userId)) >= MAX_CONCURRENT_JOBS) throw new ApiFailure('rate_limited');

    const pages = knownPages;
    const scope = { userId, classGroupId: subject.owner_class_group_id, documentId: doc.id as string };
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

    const jobId = await createAiJob(deps, { type: 'ingest.document', userId, subjectId: subject.id, documentId: doc.id as string, stage: 'S0' });
    const updated = await deps.db.from('documents').update({ status: 'processing', error_code: null }).eq('id', doc.id as string);
    if (updated.error) throw updated.error;
    // The material is processed in the background (ADR 0011): the app opens the processing screen at once and follows
    // the job row live, instead of holding the upload screen until every topic is written.
    await inBackground(deps, 'ingest.document', { document_id: doc.id, mode, ai_job_id: jobId }, doc.id as string);

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
