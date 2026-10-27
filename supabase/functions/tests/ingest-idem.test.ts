// ingest-start (checks, duplicate checksum, budget fallback to outline_only), the Idempotency-Key contract
// (replay, mismatch), and the budget store's mapping of budget_exhausted.
// deno-lint-ignore-file require-await
import { assert, assertEquals } from '@std/assert';
import { costMicroUsd, zeroUsage } from '@studify/ai';
import { estimateFullMicroUsd, estimateOutlineMicroUsd } from '../ingest-start/index.ts';
import { makeBudgetStore } from '../_shared/budget.ts';
import { ALICE, makeHarness, makePdf, request, json } from './fakes.ts';
import { IDS, seedWorld, v7 } from './world.ts';
import { handler as ingestStart } from '../ingest-start/index.ts';
import { handler as accountExport } from '../account-export/index.ts';

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

Deno.test('ingest-start: queues the document, pre-checks the budget and returns the job', async () => {
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
  assertEquals(job.options?.singletonKey, UPLOADED);
});

Deno.test('ingest-start: a checksum already in the subject → 409 duplicate_document with the existing id', async () => {
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

Deno.test('ingest-start: a document in another student’s subject is not found', async () => {
  const h = await setupH();
  await seedUpload(h, v7(303), IDS.bobSubject, 'e'.repeat(64));
  const res = await ingestStart(request('ingest-start', { idem: v7(304), body: { document_id: v7(303) } }), h.deps);
  assertEquals(res.status, 404);
  assertEquals(h.enqueued.length, 0);
});

Deno.test('ingest-start: the full run does not fit today → outline_only with budget_note (PLT-04.4)', async () => {
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

Deno.test('ingest-start: no budget for even the outline → 402 budget_exhausted, nothing queued', async () => {
  const h = await setupH();
  await seedUpload(h, UPLOADED, IDS.subject, '9'.repeat(64));
  h.budget.refuse = 'user_day';
  const res = await ingestStart(request('ingest-start', { idem: v7(307), body: { document_id: UPLOADED } }), h.deps);
  assertEquals(res.status, 402);
  assertEquals((await json(res)).error.code, 'budget_exhausted');
  assertEquals(h.enqueued.length, 0);
  assertEquals(h.db.rows('documents').find((d) => d.id === UPLOADED)?.status, 'uploaded');
});

Deno.test('Idempotency-Key: the same key and body replays the stored response; nothing runs twice', async () => {
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

Deno.test('Idempotency-Key: the same key with a different body → 409 idempotency_mismatch', async () => {
  const h = await setupH();
  const key = v7(311);
  await accountExport(request('account-export', { idem: key, body: {} }), h.deps);
  const res = await accountExport(request('account-export', { idem: key, body: { other: 1 } }), h.deps);
  assertEquals(res.status, 409);
  assertEquals((await json(res)).error.code, 'idempotency_mismatch');
});

Deno.test('budget store: budget_exhausted from the RPC becomes a refusal with scope and reset date', async () => {
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
