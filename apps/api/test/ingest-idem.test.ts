import { test } from 'bun:test';
// ingest-start (checks, duplicate checksum, budget fallback to outline_only), the Idempotency-Key contract
// (replay, mismatch), and the budget store's mapping of budget_exhausted.
// deno-lint-ignore-file require-await
import { assert, assertEquals } from './assert.ts';
import { costMicroUsd, zeroUsage } from '@studify/ai';
import { estimateFullMicroUsd, estimateOutlineMicroUsd } from '../src/functions/ingest-start.ts';
import { makeBudgetStore } from '../src/shared/budget.ts';
import { ALICE, makeHarness, makePdf, request, json } from './fakes.ts';
import { IDS, seedWorld, v7 } from './world.ts';
import { handler as ingestStart } from '../src/functions/ingest-start.ts';
import { handler as accountExport } from '../src/functions/account-export.ts';

const UPLOADED = v7(300);

async function seedUpload(h: Awaited<ReturnType<typeof setupH>>, docId: string, subjectId: string, checksum: string) {
  h.db.seed('documents', {
    id: docId,
    subject_id: subjectId,
    uploaded_by: ALICE.id,
    title: 'Caderno',
    kind: 'notes',
    storage_path: `documents/${subjectId}/${docId}.pdf`,
    size_bytes: 2048,
    checksum_sha256: checksum,
    page_count: 40,
    status: 'uploaded',
    deleted_at: null,
  });
  h.db.objects.set(`documents/${subjectId}/${docId}.pdf`, await makePdf(40));
}

async function setupH() {
  const h = makeHarness();
  await seedWorld(h);
  return h;
}

test('ingest-start: queues the document, pre-checks the budget and returns the job', async () => {
  const h = await setupH();
  await seedUpload(h, UPLOADED, IDS.subject, 'c'.repeat(64));
  const res = await ingestStart(request('ingest-start', { idem: v7(301), body: { document_id: UPLOADED } }), h.deps);
  assertEquals(res.status, 202);
  const body = await json(res);
  assertEquals(body.mode, 'full');
  assertEquals(body.estimated_pages, 40);
  assertEquals(h.budget.reserved.length, 1, 'one pre-check reservation');
  assertEquals(h.budget.settled.length, 1, 'the pre-check is released at once');
  assertEquals(h.db.rows('ai_jobs')[0]?.type, 'ingest.document');
  assertEquals(h.db.rows('documents').find((d) => d.id === UPLOADED)?.status, 'processing');
  const job = h.enqueued.find((e) => e.queue === 'ingest.document')!;
  assertEquals(job.data.document_id, UPLOADED);
  assertEquals(job.data.ai_job_id, body.job_id, 'the worker reports progress on the job the app was given');
  assertEquals(job.options?.singletonKey, UPLOADED);
  // The material is processed in the background: the app gets the job at once and follows it (ADR 0011).
  assertEquals(job.options?.startAfterSeconds, 0);
});

test('ingest-start: a checksum already in the subject → 409 duplicate_document with the existing id', async () => {
  const h = await setupH();
  const existing = v7(398);
  h.db.seed('documents', { id: existing, subject_id: IDS.subject, title: 'Já enviado', kind: 'notes', storage_path: `documents/${IDS.subject}/${existing}.pdf`, size_bytes: 2048, checksum_sha256: 'd'.repeat(64), status: 'ready', deleted_at: null });
  await seedUpload(h, UPLOADED, IDS.subject, 'd'.repeat(64));
  const res = await ingestStart(request('ingest-start', { idem: v7(302), body: { document_id: UPLOADED } }), h.deps);
  assertEquals(res.status, 409);
  const body = await json(res);
  assertEquals(body.error.code, 'duplicate_document');
  assertEquals(body.error.details.existing_document_id, existing);
});

test('ingest-start: a document in another student’s subject is not found', async () => {
  const h = await setupH();
  await seedUpload(h, v7(303), IDS.bobSubject, 'e'.repeat(64));
  const res = await ingestStart(request('ingest-start', { idem: v7(304), body: { document_id: v7(303) } }), h.deps);
  assertEquals(res.status, 404);
  assertEquals(h.enqueued.length, 0);
});

test('ingest-start: the full run does not fit today → outline_only with budget_note (PLT-04.4)', async () => {
  const h = await setupH();
  await seedUpload(h, UPLOADED, IDS.subject, 'f'.repeat(64));
  // 40 pages on Haiku 5.5: full run ≈ 18.5k micro-USD, outline ≈ 10.5k. A budget that refuses anything
  // above the midpoint forces the fallback.
  const fullMicro = estimateFullMicroUsd(40);
  const outlineMicro = estimateOutlineMicroUsd(40);
  const limit = Math.floor((fullMicro + outlineMicro) / 2);
  assert(fullMicro > limit && outlineMicro < limit);
  // The estimates price the default model: Haiku 5.5 standard card, 80,000 input tokens.
  assertEquals(outlineMicro, costMicroUsd({ ...zeroUsage(), input_tokens: 80_000, output_tokens: 5_000 }, { model: 'claude-haiku-5-5' }));
  h.deps.ai.budget = {
    reserve: async (input: { estimateMicroUsd: number }) =>
      input.estimateMicroUsd > limit
        ? { ok: false, scope: 'user_day' as const, resetsAt: '2026-10-28T00:00:00-03:00' }
        : { ok: true, reservationId: v7(305) },
    settle: async () => {},
  };
  const res = await ingestStart(request('ingest-start', { idem: v7(306), body: { document_id: UPLOADED } }), h.deps);
  assertEquals(res.status, 202);
  const body = await json(res);
  assertEquals(body.mode, 'outline_only');
  assertEquals(body.budget_note, 'outline_only_today');
});

test('ingest-start: no budget for even the outline → 402 budget_exhausted, nothing queued', async () => {
  const h = await setupH();
  await seedUpload(h, UPLOADED, IDS.subject, '9'.repeat(64));
  h.budget.refuse = 'user_day';
  const res = await ingestStart(request('ingest-start', { idem: v7(307), body: { document_id: UPLOADED } }), h.deps);
  assertEquals(res.status, 402);
  assertEquals((await json(res)).error.code, 'budget_exhausted');
  assertEquals(h.enqueued.length, 0);
  assertEquals(h.db.rows('documents').find((d) => d.id === UPLOADED)?.status, 'uploaded');
});

test('Idempotency-Key: the same key and body replays the stored response; nothing runs twice', async () => {
  const h = await setupH();
  const key = v7(310);
  const first = await accountExport(request('account-export', { idem: key, body: {} }), h.deps);
  const second = await accountExport(request('account-export', { idem: key, body: {} }), h.deps);
  assertEquals(first.status, 202);
  assertEquals(second.status, 202);
  assertEquals(second.headers.get('idempotent-replayed'), 'true');
  assertEquals(await second.text(), await first.text(), 'the same body');
  assertEquals(h.enqueued.filter((e) => e.queue === 'account.export').length, 1, 'one job');
  assertEquals(h.db.rows('data_exports').length, 1);
});

test('Idempotency-Key: the same key with a different body → 409 idempotency_mismatch', async () => {
  const h = await setupH();
  const key = v7(311);
  await accountExport(request('account-export', { idem: key, body: {} }), h.deps);
  const res = await accountExport(request('account-export', { idem: key, body: { other: 1 } }), h.deps);
  assertEquals(res.status, 409);
  assertEquals((await json(res)).error.code, 'idempotency_mismatch');
});

test('budget store: budget_exhausted from the RPC becomes a refusal with scope and reset date', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const db = {
    schema: () => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        if (fn === 'ai_budget_reserve') {
          return { data: null, error: { message: 'budget_exhausted', details: 'user', hint: 'resets_at=2026-10-28' } };
        }
        return { data: null, error: null };
      },
    }),
  };
  // deno-lint-ignore no-explicit-any
  const store = makeBudgetStore(db as any);
  const result = await store.reserve({
    ctx: { userId: ALICE.id, classGroupId: null, feature: 'TUT-01', budgetClass: 'user' },
    taskId: 'tutor.turn',
    promptVersion: 'tutor.turn@v1',
    estimateMicroUsd: 1234,
    mode: 'sync',
  });
  assertEquals(result, { ok: false, scope: 'user_day', resetsAt: '2026-10-28T00:00:00-03:00' });
  assertEquals(calls[0]?.args.p_estimate_micro_usd, 1234);
  assertEquals(calls[0]?.args.p_budget_class, 'user');
});

test('ingest-start: with subject_id the server creates the documents row from the stored file', async () => {
  const h = await setupH();
  const docId = v7(320);
  const pdf = await makePdf(3);
  h.db.objects.set(`documents/${IDS.subject}/${docId}.pdf`, pdf);
  const res = await ingestStart(
    request('ingest-start', { idem: docId, body: { document_id: docId, subject_id: IDS.subject, title: 'Resumão', kind: 'notes', teacher_name: null } }),
    h.deps,
  );
  assertEquals(res.status, 202);
  const row = h.db.rows('documents').find((d) => d.id === docId)!;
  assertEquals(row.storage_path, `${IDS.subject}/${docId}.pdf`, 'relative to the documents bucket, as the worker reads it');
  assertEquals(row.uploaded_by, ALICE.id);
  assertEquals(row.title, 'Resumão');
  assertEquals(row.size_bytes, pdf.byteLength);
  assertEquals((row.checksum_sha256 as string).length, 64);
  assertEquals(row.status, 'processing');
  assertEquals(h.enqueued.find((e) => e.queue === 'ingest.document')?.data.document_id, docId);
});

test('ingest-start: an uploaded copy of a file already in the subject → duplicate, and the copy is removed', async () => {
  const h = await setupH();
  const pdf = await makePdf(3);
  const first = v7(321);
  h.db.objects.set(`documents/${IDS.subject}/${first}.pdf`, pdf);
  assertEquals((await ingestStart(request('ingest-start', { idem: first, body: { document_id: first, subject_id: IDS.subject } }), h.deps)).status, 202);
  const second = v7(322);
  h.db.objects.set(`documents/${IDS.subject}/${second}.pdf`, pdf);
  const res = await ingestStart(request('ingest-start', { idem: second, body: { document_id: second, subject_id: IDS.subject } }), h.deps);
  assertEquals(res.status, 409);
  assertEquals((await json(res)).error.details.existing_document_id, first);
  assert(!h.db.objects.has(`documents/${IDS.subject}/${second}.pdf`), 'the rejected copy is gone');
  assert(!h.db.rows('documents').some((d) => d.id === second));
});

test('ingest-start: a file that is not a PDF is rejected and removed', async () => {
  const h = await setupH();
  const docId = v7(323);
  h.db.objects.set(`documents/${IDS.subject}/${docId}.pdf`, new TextEncoder().encode('hello, not a pdf'));
  const res = await ingestStart(request('ingest-start', { idem: docId, body: { document_id: docId, subject_id: IDS.subject } }), h.deps);
  assertEquals(res.status, 422);
  assertEquals((await json(res)).error.code, 'pdf_corrupt');
  assert(!h.db.objects.has(`documents/${IDS.subject}/${docId}.pdf`));
});

test('ingest-start: creating a document in another student’s subject is not found', async () => {
  const h = await setupH();
  const docId = v7(324);
  h.db.objects.set(`documents/${IDS.bobSubject}/${docId}.pdf`, await makePdf(1));
  const res = await ingestStart(request('ingest-start', { idem: docId, body: { document_id: docId, subject_id: IDS.bobSubject } }), h.deps);
  assertEquals(res.status, 404);
  assert(!h.db.rows('documents').some((d) => d.id === docId));
});
