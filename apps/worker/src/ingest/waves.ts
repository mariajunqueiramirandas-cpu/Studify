// Batch waves (ai-pipeline §7): build the requests of one wave, submit them, and store a plan in the
// batch.poll payload. The plan carries everything needed to route a result (block order for citations, labels
// for page mapping, the budget context and the custom_id → topic/kind mapping), so the poll job needs no
// other state. Results that fail are re-run on the standard API, rebuilt from the same plan (ai-pipeline §7.3).
import { callClaude, collectBatch, pollBatch, submitBatch, BudgetExceededError, type BatchItem, type BatchSubmission, type BudgetContext, type CallResult, type MappedCitation, type TaskCall } from '@studify/ai';
import { getTask } from '@studify/prompts';
import { getDocument, type PipelineEnv } from './env.ts';
import { buildPagesCustomId, buildTopicCustomId, type TopicKind } from './custom-id.ts';
import { aiTask, prepareCall, toPdfSlices, type SliceRef } from './tasks.ts';
import { buildKindCall, featureOf, loadTopicBundle, writeCards, writeConcepts, writeFeed, writeGlossary, writeNote, writeQuestions, type TopicBundle, type WriteContext } from './topics.ts';
import { TRANSCRIPTION_PAGES } from './limits.ts';
import { pagesToSpans } from './slice-plan.ts';
import { applyProgress } from '../framework/progress.ts';
import { PermanentJobError } from '../framework/errors.ts';
import type { LabelMap } from './mappers.ts';
import { normalizeTerm } from './text.ts';
import { upsertPages } from './repo.ts';

export const BATCH_POLL_INTERVAL_S = 60;
export const BATCH_MAX_WAIT_MS = 60 * 60_000;

export interface PlanBlock {
  documentId: string;
  pages: number[];
}

export interface PlanItem {
  customId: string;
  kind: TopicKind | 'transcription';
  topicId: string | null;
  taskId: string;
  promptVersion: string;
  blocks: PlanBlock[];
  budget: BudgetContext;
  language: string;
  genBatchId: string;
  force: boolean;
  /** Transcription runs: the original page range (inclusive). */
  pages: { start: number; end: number } | null;
}

export type PlanPurpose = 'concepts' | 'content' | 'transcription';

export interface WavePlan {
  batchId: string;
  reservationId: string;
  estimateMicroUsd: number;
  submittedAt: string;
  purpose: PlanPurpose;
  aiJobId: string | null;
  userId: string | null;
  subjectId: string;
  documentId: string | null;
  topicIds: string[];
  pollCount: number;
  items: PlanItem[];
}

export function labelsOfBlocks(blocks: readonly PlanBlock[]): LabelMap {
  const labels: Record<string, string> = {};
  const allowedPages: Record<string, number[]> = {};
  blocks.forEach((b, i) => {
    labels[`D${i + 1}`] = b.documentId;
    allowedPages[`D${i + 1}`] = [...b.pages];
  });
  return { labels, allowedPages };
}

/** Slice references for a plan's blocks (base64), in block order. Same bytes as the submitted requests. */
export async function refsFromBlocks(env: PipelineEnv, blocks: readonly PlanBlock[], purpose: 'topic' | 'transcription'): Promise<SliceRef[]> {
  const refs: SliceRef[] = [];
  for (const block of blocks) {
    const doc = await getDocument(env, block.documentId);
    if (!doc) throw new PermanentJobError('storage_missing', `document ${block.documentId} not found`);
    const span = { start: block.pages[0] as number, end: block.pages[block.pages.length - 1] as number };
    const cached = await env.sources.slice(doc, span, purpose);
    refs.push({
      id: cached.id,
      documentId: doc.id,
      title: doc.title,
      pages: cached.pages,
      tokenCount: null,
      source: { kind: 'base64', data: Buffer.from(cached.bytes).toString('base64') },
    });
  }
  return refs;
}

/** Lite call used by collectBatch: only the task, the budget context and the block order are read. */
function liteCall(item: PlanItem): TaskCall<unknown> {
  return {
    task: aiTask(item.taskId),
    ctx: item.budget,
    system: [],
    messages: [],
    sources: item.blocks.map((b, i) => ({
      id: `block-${i}`,
      documentId: b.documentId,
      title: '',
      pages: b.pages,
      tokenCount: null,
    })),
  };
}

export interface SubmitInput {
  purpose: PlanPurpose;
  aiJobId: string | null;
  userId: string | null;
  subjectId: string;
  documentId: string | null;
  topicIds: string[];
  items: Array<{ item: PlanItem; call: TaskCall<unknown> }>;
}

/** Submits one wave and enqueues its poll. Throws BudgetExceededError when the wave does not fit. */
export async function submitWave(env: PipelineEnv, input: SubmitInput): Promise<WavePlan> {
  const first = input.items[0]?.item.budget;
  if (!first) throw new Error('submitWave needs at least one item');
  const submission: BatchSubmission = await submitBatch(env.ctx.ai, {
    ctx: first,
    items: input.items.map(({ item, call }) => ({ customId: item.customId, call })),
  });
  const plan: WavePlan = {
    batchId: submission.batchId,
    reservationId: submission.reservationId,
    estimateMicroUsd: submission.estimateMicroUsd,
    submittedAt: submission.submittedAt,
    purpose: input.purpose,
    aiJobId: input.aiJobId,
    userId: input.userId,
    subjectId: input.subjectId,
    documentId: input.documentId,
    topicIds: input.topicIds,
    pollCount: 0,
    items: input.items.map((i) => i.item),
  };
  await env.ctx.enqueue('batch.poll', { ai_job_id: input.aiJobId, plan: plan as unknown as Record<string, unknown> }, {
    startAfter: BATCH_POLL_INTERVAL_S,
    singletonKey: `batch:${plan.batchId}`,
  });
  if (input.aiJobId) {
    await applyProgress(env.ctx.db, input.aiJobId, {
      stage: input.purpose === 'concepts' ? 'S2' : input.purpose === 'content' ? 'S4' : 'transcription',
      status: 'waiting_batch',
      batch_id: plan.batchId,
      items_total: input.topicIds.length,
      items_done: 0,
    });
  }
  return plan;
}

/** Builds a PlanItem and the TaskCall for one topic kind. */
export async function topicItem(
  env: PipelineEnv,
  bundle: TopicBundle,
  kind: TopicKind,
  refs: SliceRef[],
  opts: { jobId: string | null; userId: string | null; documentId: string | null; genBatchId: string; force: boolean; language: string },
): Promise<{ item: PlanItem; call: TaskCall<unknown> }> {
  const budget = {
    userId: opts.userId,
    classGroupId: bundle.subject.ownerClassGroupId,
    subjectId: bundle.subjectId,
    documentId: opts.documentId,
    nodeId: bundle.topicId,
    jobId: opts.jobId,
    feature: featureOf(kind),
    budgetClass: 'content' as const,
  };
  const built = await buildKindCall(env, bundle, kind, refs, budget, opts.language);
  const item: PlanItem = {
    customId: buildTopicCustomId(bundle.topicId, kind),
    kind,
    topicId: bundle.topicId,
    taskId: built.taskId,
    promptVersion: built.promptVersion,
    blocks: refs.map((r) => ({ documentId: r.documentId, pages: r.pages })),
    budget,
    language: opts.language,
    genBatchId: opts.genBatchId,
    force: opts.force,
    pages: null,
  };
  return { item, call: built.call };
}

/** Transcription run (ingest.transcribePages, ai-pipeline T4): consecutive scanned pages, ≤ 20 per request. */
export function transcriptionRuns(pages: readonly number[]): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const span of pagesToSpans(pages)) {
    for (let s = span.start; s <= span.end; s += TRANSCRIPTION_PAGES) {
      out.push({ start: s, end: Math.min(span.end, s + TRANSCRIPTION_PAGES - 1) });
    }
  }
  return out;
}

export async function transcriptionItem(
  env: PipelineEnv,
  doc: { id: string; title: string; storagePath: string },
  run: { start: number; end: number },
  opts: { jobId: string | null; userId: string | null; subjectId: string; ownerClassGroupId: string | null; language: string; genBatchId: string },
): Promise<{ item: PlanItem; call: TaskCall<unknown> }> {
  const pages = Array.from({ length: run.end - run.start + 1 }, (_, i) => run.start + i);
  const cached = await env.sources.slice({ id: doc.id, storagePath: doc.storagePath }, run, 'transcription');
  const ref: SliceRef = {
    id: cached.id,
    documentId: doc.id,
    title: doc.title,
    pages,
    tokenCount: null,
    source: { kind: 'base64', data: Buffer.from(cached.bytes).toString('base64') },
  };
  const budget: BudgetContext = {
    userId: opts.userId,
    classGroupId: opts.ownerClassGroupId,
    subjectId: opts.subjectId,
    documentId: doc.id,
    nodeId: null,
    jobId: opts.jobId,
    feature: 'ING-02',
    budgetClass: 'content',
  };
  const built = getTask('ingest.transcribePages').build({ slice: toPdfSlices([ref])[0]!, contentLanguage: opts.language });
  const prepared = prepareCall('ingest.transcribePages', built, budget, [ref]);
  const item: PlanItem = {
    customId: buildPagesCustomId(run.start, run.end),
    kind: 'transcription',
    topicId: null,
    taskId: 'ingest.transcribePages',
    promptVersion: built.promptVersion,
    blocks: [{ documentId: doc.id, pages }],
    budget,
    language: opts.language,
    genBatchId: opts.genBatchId,
    force: false,
    pages: run,
  };
  return { item, call: prepared.call };
}

/**
 * Rebuilds the standard-API call for an item that failed in the batch. Same prompt, same slices, and no
 * fallbacks on Batch requests (ai-pipeline §7.4): the standard path is where the refusal fallback applies.
 */
async function rerunStandard(env: PipelineEnv, item: PlanItem): Promise<CallResult<unknown>> {
  const refs = await refsFromBlocks(env, item.blocks, item.kind === 'transcription' ? 'transcription' : 'topic');
  if (item.kind === 'transcription') {
    const built = getTask('ingest.transcribePages').build({ slice: toPdfSlices(refs)[0]!, contentLanguage: item.language });
    const prepared = prepareCall('ingest.transcribePages', built, item.budget, refs);
    return callClaude(env.ctx.ai, prepared.call);
  }
  const bundle = await loadTopicBundle(env.ctx.db, item.topicId as string);
  if (!bundle) throw new Error(`topic ${item.topicId} disappeared before rerun`);
  const built = await buildKindCall(env, bundle, item.kind, refs, item.budget, item.language);
  return callClaude(env.ctx.ai, built.call);
}

export interface PollOutcomeSummary {
  done: boolean;
  /** Topic ids whose content was written (content purpose) or attempted. */
  topicsOk: Set<string>;
  topicsFailed: Set<string>;
  budgetExceeded: boolean;
}

/**
 * One poll of a wave. Pending waves re-enqueue themselves (60 s, api.md §7); ended waves are collected and
 * written. Returns done = true only when the wave was collected.
 */
export async function pollWave(env: PipelineEnv, plan: WavePlan): Promise<PollOutcomeSummary> {
  const deps = env.ctx.ai;
  const status = await pollBatch(deps, plan.batchId);
  const summary: PollOutcomeSummary = { done: false, topicsOk: new Set(), topicsFailed: new Set(), budgetExceeded: false };
  if (status.processingStatus !== 'ended') {
    const elapsed = env.ctx.now().getTime() - Date.parse(plan.submittedAt);
    if (elapsed > BATCH_MAX_WAIT_MS) {
      await deps.client.beta.messages.batches.cancel(plan.batchId).catch(() => undefined);
    }
    if (plan.aiJobId) {
      const done = status.counts.succeeded + status.counts.errored + status.counts.canceled + status.counts.expired;
      await applyProgress(env.ctx.db, plan.aiJobId, {
        status: 'waiting_batch',
        batch_id: plan.batchId,
        items_total: plan.items.length,
        items_done: Math.min(plan.items.length, done),
      });
    }
    await env.ctx.enqueue('batch.poll', { ai_job_id: plan.aiJobId, plan: { ...plan, pollCount: plan.pollCount + 1 } as unknown as Record<string, unknown> }, {
      startAfter: BATCH_POLL_INTERVAL_S,
      singletonKey: `batch:${plan.batchId}:${plan.pollCount + 1}`,
    });
    return summary;
  }

  const submission: BatchSubmission = {
    batchId: plan.batchId,
    reservationId: plan.reservationId,
    estimateMicroUsd: plan.estimateMicroUsd,
    customIds: plan.items.map((i) => i.customId),
    submittedAt: plan.submittedAt,
  };
  const batchItems: BatchItem[] = plan.items.map((item) => ({ customId: item.customId, call: liteCall(item) }));
  const collected = await collectBatch(deps, submission, batchItems);
  summary.done = true;

  const byId = new Map(plan.items.map((i) => [i.customId, i]));
  for (const outcome of collected.outcomes) {
    const item = byId.get(outcome.customId);
    if (!item) continue;
    let handled = false;
    if (outcome.status === 'ok') {
      handled = await writeOutcome(env, item, outcome.data, outcome.text, outcome.citations);
    } else {
      // Refused, truncated, invalid, errored (retryable), canceled, expired or missing: one standard-API retry.
      try {
        const rerun = await rerunStandard(env, item);
        if (rerun.status === 'ok') {
          handled = await writeOutcome(env, item, rerun.data, rerun.text, rerun.citations);
        } else {
          env.ctx.log.warn({ customId: item.customId, status: rerun.status }, 'standard rerun did not produce output');
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          summary.budgetExceeded = true;
        } else {
          env.ctx.log.warn({ customId: item.customId, err: err instanceof Error ? err.name : 'unknown' }, 'standard rerun failed');
        }
      }
    }
    if (item.topicId) {
      if (handled) summary.topicsOk.add(item.topicId);
      else summary.topicsFailed.add(item.topicId);
    }
  }
  return summary;
}

/** Routes one successful output to its writer. Returns true when rows were written (or intentionally kept). */
export async function writeOutcome(
  env: PipelineEnv,
  item: PlanItem,
  data: unknown,
  text: string,
  citations: readonly MappedCitation[],
): Promise<boolean> {
  if (item.kind === 'transcription') {
    return writeTranscription(env, item, data as { pages: Array<{ page: number; text: string; confidence: 'high' | 'medium' | 'low' }> });
  }
  const bundle = await loadTopicBundle(env.ctx.db, item.topicId as string);
  if (!bundle) return false;
  const labels = labelsOfBlocks(item.blocks);
  const ctx: WriteContext = {
    pool: env.ctx.db,
    bundle,
    createdBy: item.budget.userId ?? bundle.subject.createdBy,
    labels,
    promptVersion: item.promptVersion,
    genBatchId: item.genBatchId,
    language: item.language,
    force: item.force,
  };
  switch (item.kind) {
    case 'concepts': {
      const existing = new Map(bundle.concepts.map((c) => [normalizeTerm(c.title), c.id]));
      const result = await writeConcepts(ctx, data as Parameters<typeof writeConcepts>[1], existing);
      env.ctx.log.info({ written: result.written, dropped: result.dropped }, 'concepts written');
      return true;
    }
    case 'tldr':
    case 'study':
    case 'deep':
      await writeNote(ctx, item.kind, text, citations);
      return true;
    case 'glossary':
      await writeGlossary(ctx, data as Parameters<typeof writeGlossary>[1]);
      return true;
    case 'cards': {
      const fronts = new Set((await existingFrontKeys(env, bundle.subjectId)));
      await writeCards(ctx, data as Parameters<typeof writeCards>[1], fronts);
      return true;
    }
    case 'questions': {
      const result = await writeQuestions(ctx, data as Parameters<typeof writeQuestions>[1]);
      env.ctx.log.info({ written: result.written, dropped: result.dropped }, 'questions written');
      return true;
    }
    case 'feed':
      await writeFeed(ctx, data as Parameters<typeof writeFeed>[1]);
      return true;
  }
}

async function existingFrontKeys(env: PipelineEnv, subjectId: string): Promise<string[]> {
  const { rows } = await env.ctx.db.query<{ front: string }>(
    `select front from public.cards where subject_id = $1 and deleted_at is null and status = 'active' limit 500`,
    [subjectId],
  );
  return rows.map((r) => normalizeTerm(r.front));
}

async function writeTranscription(
  env: PipelineEnv,
  item: PlanItem,
  data: { pages: Array<{ page: number; text: string; confidence: 'high' | 'medium' | 'low' }> },
): Promise<boolean> {
  const documentId = item.blocks[0]?.documentId;
  if (!documentId) return false;
  const pages = data.pages
    .filter((p) => item.pages && p.page >= item.pages.start && p.page <= item.pages.end)
    .map((p) => ({
      pageNumber: p.page,
      text: p.text,
      textSource: 'ai_transcription' as const,
      charCount: p.text.replace(/\s/g, '').length,
      hasImages: false,
      imagePath: null,
      thumbnailPath: null,
      textItemsPath: null,
      transcriptionConfidence: p.confidence,
    }));
  await upsertPages(env.ctx.db, documentId, pages);
  return pages.length > 0;
}

