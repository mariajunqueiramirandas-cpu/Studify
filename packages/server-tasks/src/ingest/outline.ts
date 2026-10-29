// S1 outline (spec 01 §8.2, ai-pipeline §7.5): standard API, streamed, ≤ 4 slices in parallel. Outline
// slices are uploaded to the Files API for the duration of the stage and deleted when it ends (ai-pipeline
// §4.2). A document with more than one slice gets one text-only merge call (T1b). The nodes are written in
// one transaction under an advisory lock on the subject, so two concurrent uploads cannot double-merge.
import { AiRetryLaterError, callClaude, deleteFile, uploadSliceFile, type CallResult } from '@studify/ai';
import { getTask, type ExistingNode, type OutlineInput } from '@studify/prompts';
import { uuidV7 } from '@studify/shared';
import type pg from 'pg';
import { withTransaction, type Sql } from '../framework/db.ts';
import { mapLimit } from './concurrency.ts';
import { budgetFor, estimateTokens, type CachedSlice, type PipelineEnv } from './env.ts';
import { prepareCall, toPdfSlices, type SliceRef } from './tasks.ts';
import { planOutlineSlices, type PageSpan } from './slice-plan.ts';
import { normalizeOutline, type NormalizedOutline, type OutlineOut } from './outline-normalize.ts';
import { listNodes, nodeSourcesOfDocument, documentHasNodes, patchDocument, type DocumentRecord, type NodeRow } from './repo.ts';
import { MAX_SLICE_BYTES } from './limits.ts';
import { withShortCache } from '../lib/ai-adapter.ts';

export const OUTLINE_CONCURRENCY = 4;
export const S1_RETRY_DELAYS_MS = [2_000, 8_000, 30_000];

export type OutlineStageResult =
  | { status: 'ok'; outline: NormalizedOutline; sliceCount: number; touchedTopics: TouchedTopic[]; warnings: string[] }
  | { status: 'failed'; code: 'ai_failed' | 'ai_refused' | 'not_study_material' };

export interface TouchedTopic {
  topicId: string;
  unitId: string | null;
  pageStart: number;
  pageEnd: number;
}

export function existingForPrompt(nodes: readonly NodeRow[]): ExistingNode[] {
  return nodes
    .filter((n) => n.kind === 'unit' || n.kind === 'topic')
    .map((n) => ({
      id: n.id,
      kind: n.kind as 'unit' | 'topic',
      title: n.title,
      summary: n.summary,
      parentId: n.parentId,
    }));
}

export function kindHintFor(kind: string): OutlineInput['kindHint'] {
  return kind === 'slides' || kind === 'notes' || kind === 'textbook' || kind === 'past_test' || kind === 'content_list'
    ? kind
    : null;
}

/** Slices of a document for S1, halved until each fits the 20 MB request budget (spec 01 §8.1). */
export async function outlineSlices(env: PipelineEnv, doc: DocumentRecord, pageCount: number, cutStarts: readonly number[]): Promise<CachedSlice[]> {
  const planned = planOutlineSlices(pageCount, cutStarts);
  const out: CachedSlice[] = [];
  for (const span of planned) {
    const parts = await fitSpan(env, doc, span);
    out.push(...parts);
  }
  return out;
}

async function fitSpan(env: PipelineEnv, doc: DocumentRecord, span: PageSpan): Promise<CachedSlice[]> {
  const slice = await env.sources.slice(doc, span, 'outline');
  if (slice.bytes.byteLength <= MAX_SLICE_BYTES || span.end === span.start) return [slice];
  const mid = Math.floor((span.start + span.end) / 2);
  return [
    ...(await fitSpan(env, doc, { start: span.start, end: mid })),
    ...(await fitSpan(env, doc, { start: mid + 1, end: span.end })),
  ];
}

/**
 * Runs S1 for one document: slices, calls, optional merge. Does not write nodes; see writeOutline.
 * Throws BudgetExceededError (the pipeline turns it into waiting_budget).
 */
export async function runOutlineCalls(
  env: PipelineEnv,
  doc: DocumentRecord,
  input: { jobId: string | null; pageCount: number; cutStarts: readonly number[]; existing: readonly NodeRow[] },
): Promise<{ status: 'ok'; outline: OutlineOut; sliceCount: number } | { status: 'failed'; code: 'ai_failed' | 'ai_refused' }> {
  const sql: Sql = env.ctx.db;
  const slices = await outlineSlices(env, doc, input.pageCount, input.cutStarts);
  const client = env.ctx.ai.client;
  const uploaded = new Map<string, string>();
  try {
    for (const slice of slices) {
      const up = await uploadSliceFile({ client, clock: env.ctx.ai.clock }, { sliceId: slice.id, bytes: slice.bytes });
      uploaded.set(slice.id, up.fileId);
      await sql.query(
        `update public.document_slices set anthropic_file_id = $2, anthropic_file_expires_at = $3, updated_at = now() where id = $1`,
        [slice.id, up.fileId, up.expiresAt],
      );
    }

    const existing = existingForPrompt(input.existing);
    const results = await mapLimit(slices, OUTLINE_CONCURRENCY, async (slice) => {
      const fileId = uploaded.get(slice.id) as string;
      const ref: SliceRef = {
        id: slice.id,
        documentId: doc.id,
        title: doc.title,
        pages: slice.pages,
        tokenCount: estimateTokens(slice.pages.length),
        source: { kind: 'file', fileId },
      };
      const [pdfSlice] = toPdfSlices([ref]);
      const built = getTask('ingest.outline').build({
        subjectName: doc.subjectName,
        fileName: doc.title,
        slice: pdfSlice,
        kindHint: kindHintFor(doc.kind),
        existing,
      });
      const prepared = prepareCall('ingest.outline', built, budgetFor({ ...doc, documentId: doc.id }, { jobId: input.jobId, feature: 'ING-03' }), [ref]);
      return withS1Retries(env, () => callClaude(env.ctx.ai, withShortCache(prepared.call)));
    });

    const outlines: unknown[] = [];
    for (const result of results) {
      if (result.status === 'refused') return { status: 'failed', code: 'ai_refused' };
      if (result.status !== 'ok') return { status: 'failed', code: 'ai_failed' };
      outlines.push(result.data);
    }

    if (outlines.length === 1) return { status: 'ok', outline: outlines[0] as OutlineOut, sliceCount: 1 };

    const mergeBuilt = getTask('ingest.outlineMerge').build({
      subjectName: doc.subjectName,
      sliceOutlines: outlines,
      existing,
    });
    const mergeCall = prepareCall('ingest.outlineMerge', mergeBuilt, budgetFor({ ...doc, documentId: doc.id }, { jobId: input.jobId, feature: 'ING-03' }), []);
    const merged = await callClaude(env.ctx.ai, withShortCache(mergeCall.call));
    if (merged.status === 'refused') return { status: 'failed', code: 'ai_refused' };
    if (merged.status !== 'ok') return { status: 'failed', code: 'ai_failed' };
    return { status: 'ok', outline: merged.data as OutlineOut, sliceCount: slices.length };
  } finally {
    // Files API objects live only for this stage (ai-pipeline §4.2).
    for (const [sliceId, fileId] of uploaded) {
      await deleteFile(client, fileId).catch(() => undefined);
      await sql.query(`update public.document_slices set anthropic_file_id = null, anthropic_file_expires_at = null where id = $1`, [sliceId]);
    }
  }
}

async function withS1Retries<T extends CallResult<unknown>>(env: PipelineEnv, call: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof AiRetryLaterError) || attempt >= S1_RETRY_DELAYS_MS.length) throw err;
      const delay = S1_RETRY_DELAYS_MS[attempt] as number;
      attempt++;
      env.ctx.log.warn({ attempt, delayMs: delay, status: err.status }, 'S1 retry after transient error');
      await (env.ctx.ai.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(delay);
    }
  }
}

/**
 * Writes the outline into the knowledge map. Idempotent for the document: when its nodes already exist,
 * the stored state is returned. Runs in one transaction under a per-subject advisory lock.
 */
export async function writeOutline(
  pool: pg.Pool,
  doc: Pick<DocumentRecord, 'id' | 'subjectId'>,
  raw: OutlineOut,
  pageCount: number,
): Promise<{ normalized: NormalizedOutline; touched: TouchedTopic[] }> {
  return withTransaction(pool, async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [doc.subjectId]);
    if (await documentHasNodes(client, doc.id)) {
      const touched = await touchedTopics(client, doc.id);
      return { normalized: { isStudyMaterial: true, language: raw.language, detectedKind: raw.detected_kind, units: [], warnings: [] }, touched };
    }
    const nodes = await listNodes(client, doc.subjectId);
    const units = nodes.filter((n) => n.kind === 'unit');
    const topics = nodes.filter((n) => n.kind === 'topic');
    const normalized = normalizeOutline(raw, {
      pageCount,
      existingUnitIds: new Set(units.map((u) => u.id)),
      existingTopicIds: new Set(topics.map((t) => t.id)),
      existingTopicCount: topics.length,
    });
    await patchDocument(client, doc.id, { language: normalized.language, detectedKind: normalized.detectedKind });
    if (!normalized.isStudyMaterial) {
      return { normalized, touched: [] };
    }

    let unitPosition = units.length > 0 ? Math.max(...units.map((u) => u.position)) + 1 : 0;
    for (const unit of normalized.units) {
      let unitId = unit.matchId;
      if (!unitId) {
        unitId = uuidV7();
        await insertNode(client, {
          id: unitId,
          subjectId: doc.subjectId,
          parentId: null,
          kind: 'unit',
          title: unit.title,
          summary: unit.summary,
          position: unitPosition++,
          objectives: [],
          originDocumentId: doc.id,
        });
      }
      await insertSource(client, unitId, doc.id, unit.pageStart, unit.pageEnd);

      const siblings = topics.filter((t) => t.parentId === unitId);
      let topicPosition = siblings.length > 0 ? Math.max(...siblings.map((t) => t.position)) + 1 : 0;
      for (const topic of unit.topics) {
        let topicId = topic.matchId;
        if (!topicId) {
          topicId = uuidV7();
          await insertNode(client, {
            id: topicId,
            subjectId: doc.subjectId,
            parentId: unitId,
            kind: 'topic',
            title: topic.title,
            summary: topic.summary,
            position: topicPosition++,
            objectives: topic.objectives,
            originDocumentId: doc.id,
          });
        }
        await insertSource(client, topicId, doc.id, topic.pageStart, topic.pageEnd);
      }
    }
    return { normalized, touched: await touchedTopics(client, doc.id) };
  });
}

async function touchedTopics(sql: Sql, documentId: string): Promise<TouchedTopic[]> {
  const sources = await nodeSourcesOfDocument(sql, documentId);
  const topics = sources.filter((s) => s.kind === 'topic');
  const { rows } = await sql.query<{ id: string; parent_id: string | null }>(
    `select id, parent_id from public.knowledge_nodes where id = any($1::uuid[])`,
    [topics.map((t) => t.nodeId)],
  );
  const parent = new Map(rows.map((r) => [r.id, r.parent_id]));
  return topics.map((t) => ({
    topicId: t.nodeId,
    unitId: parent.get(t.nodeId) ?? null,
    pageStart: t.pageStart,
    pageEnd: t.pageEnd,
  }));
}

interface NodeInsert {
  id: string;
  subjectId: string;
  parentId: string | null;
  kind: 'unit' | 'topic';
  title: string;
  summary: string | null;
  position: number;
  objectives: string[];
  originDocumentId: string;
}

async function insertNode(sql: Sql, n: NodeInsert): Promise<void> {
  await sql.query(
    `insert into public.knowledge_nodes
       (id, subject_id, parent_id, kind, title, summary, position, learning_objectives, origin_document_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [n.id, n.subjectId, n.parentId, n.kind, n.title, n.summary, n.position, n.objectives, n.originDocumentId],
  );
}

async function insertSource(sql: Sql, nodeId: string, documentId: string, pageStart: number, pageEnd: number): Promise<void> {
  await sql.query(
    `insert into public.node_sources (node_id, document_id, page_start, page_end, origin)
     values ($1, $2, $3, $4, 'ai')
     on conflict (node_id, document_id, page_start, page_end) do nothing`,
    [nodeId, documentId, pageStart, pageEnd],
  );
}

