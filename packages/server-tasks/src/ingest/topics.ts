// Topic content (S2 concepts, S4 notes, glossary, cards, questions, feed): loads a topic's bundle from the
// map, builds the prompts input for each kind, and writes the outputs. Calls are built the same way for the
// Batch path and the standard-API path, so a re-run uses the same prompt bytes (ai-pipeline §6.1).
import { cardTargetCount, decodeQuestion, getTask, topicQuotas, withContextPages, type QuestionDraft as ModelQuestionDraft, type QuotaMap } from '@studify/prompts';
import type { PdfSlice } from '@studify/prompts';
import { checkProblemConsistency, parseQuestionPayload, uuidV7, type QuestionType } from '@studify/shared';
import type { BudgetContext, MappedCitation, TaskCall } from '@studify/ai';
import type pg from 'pg';
import { tableExists, withTransaction, type Sql } from '../framework/db.ts';
import { budgetFor, getDocument, type PipelineEnv } from './env.ts';
import { TASK_FOR_KIND, type TopicKind } from './custom-id.ts';
import { pagesToSpans, splitSpan, type PageSpan } from './slice-plan.ts';
import { TOPIC_SLICE_PAGES } from './limits.ts';
import { prepareCall, toPdfSlices, type SliceRef } from './tasks.ts';
import {
  mapCard,
  mapFindError,
  mapGlossaryTerm,
  mapProblem,
  mapQuestion,
  cardFrontKey,
  fadeWorkedExamples,
  toSourcePages,
  type CardDraftInput,
  type FindErrorDraft,
  type GlossaryDraftInput,
  type LabelMap,
  type ProblemDraft,
  type QuestionDraft,
  type QuestionRow,
  type WorkedExampleDraft,
} from './mappers.ts';
import { renderCitedBody, type CitationInput } from './citations.ts';
import { loadSubject, type SubjectRecord } from './repo.ts';
import { normalizeTerm } from './text.ts';

export interface ConceptView {
  id: string;
  key: string;
  title: string;
  summary: string;
  keyTerms: string[];
  formulas: Array<{ latex: string; description: string }>;
  position: number;
}

export interface SourceSpan {
  documentId: string;
  pageStart: number;
  pageEnd: number;
}

export interface TopicBundle {
  topicId: string;
  subjectId: string;
  unitId: string | null;
  title: string;
  summary: string;
  objectives: string[];
  siblingTitles: string[];
  concepts: ConceptView[];
  conceptIdByKey: Map<string, string>;
  sources: SourceSpan[];
  subject: SubjectRecord;
}

export async function loadTopicBundle(sql: Sql, topicId: string): Promise<TopicBundle | null> {
  const topicRow = await sql.query<{
    id: string;
    subject_id: string;
    parent_id: string | null;
    title: string;
    summary: string | null;
    learning_objectives: string[];
  }>(
    `select id, subject_id, parent_id, title, summary, learning_objectives
       from public.knowledge_nodes where id = $1 and kind = 'topic' and deleted_at is null`,
    [topicId],
  );
  const topic = topicRow.rows[0];
  if (!topic) return null;
  const subject = await loadSubject(sql, topic.subject_id);
  if (!subject) return null;

  const siblings = await sql.query<{ title: string }>(
    `select title from public.knowledge_nodes
      where parent_id is not distinct from $1 and kind = 'topic' and id <> $2 and deleted_at is null
      order by position, id`,
    [topic.parent_id, topicId],
  );
  const concepts = await sql.query<{ id: string; title: string; summary: string | null; key_terms: string[]; formulas: unknown; position: number }>(
    `select id, title, summary, key_terms, formulas, position from public.knowledge_nodes
      where parent_id = $1 and kind = 'concept' and deleted_at is null order by position, id`,
    [topicId],
  );
  const sources = await sql.query<{ document_id: string; page_start: number; page_end: number }>(
    `select document_id, page_start, page_end from public.node_sources
      where node_id = $1 and deleted_at is null order by document_id, page_start`,
    [topicId],
  );

  const conceptViews: ConceptView[] = concepts.rows.map((c, i) => ({
    id: c.id,
    key: `c${i + 1}`,
    title: c.title,
    summary: c.summary ?? '',
    keyTerms: c.key_terms ?? [],
    formulas: Array.isArray(c.formulas) ? (c.formulas as ConceptView['formulas']) : [],
    position: c.position,
  }));
  return {
    topicId,
    subjectId: subject.id,
    unitId: topic.parent_id,
    title: topic.title,
    summary: topic.summary ?? '',
    objectives: topic.learning_objectives ?? [],
    siblingTitles: siblings.rows.map((s) => s.title),
    concepts: conceptViews,
    conceptIdByKey: new Map(conceptViews.map((c) => [c.key, c.id])),
    sources: sources.rows.map((s) => ({ documentId: s.document_id, pageStart: s.page_start, pageEnd: s.page_end })),
    subject,
  };
}

/** Pages of the topic that came from one document (S2 works on the pages of the current upload only). */
export function sourcesOf(bundle: TopicBundle, documentId?: string): SourceSpan[] {
  return bundle.sources.filter((s) => !documentId || s.documentId === documentId);
}

/**
 * Slice references for a topic's pages: one `topic` slice per ≤ 60 consecutive pages, per document, in the
 * order the prompts builder labels them (document id, first page). Each slice is base64 for the request.
 * With `context` (the default) every run of pages gets one neighboring page on each side, so a subject cut by a
 * page break reaches the model whole; `focusPages` tells the prompt which pages are the topic's own. Callers
 * that slice a whole document (the material check) turn it off.
 */
export async function topicSliceRefs(env: PipelineEnv, sources: readonly SourceSpan[], opts: { context?: boolean } = {}): Promise<SliceRef[]> {
  const context = opts.context ?? true;
  // One page set per document: overlapping spans (and their context pages) are sent once.
  const byDoc = new Map<string, Set<number>>();
  for (const source of sources) {
    const pages = byDoc.get(source.documentId) ?? new Set<number>();
    for (let p = source.pageStart; p <= source.pageEnd; p += 1) pages.add(p);
    byDoc.set(source.documentId, pages);
  }
  const refs: SliceRef[] = [];
  for (const documentId of [...byDoc.keys()].sort((a, b) => a.localeCompare(b))) {
    const doc = await getDocument(env, documentId);
    if (!doc) throw new Error(`document ${documentId} not found for topic slices`);
    const own = [...byDoc.get(documentId)!];
    const { pages, focus } = context ? withContextPages(own, doc.pageCount) : { pages: own, focus: own };
    for (const run of pagesToSpans(pages)) {
      for (const span of topicChunks(run, focus)) {
        const cached = await env.sources.slice(doc, span, 'topic');
        const focusPages = cached.pages.filter((p) => focus.includes(p));
        refs.push({
          id: cached.id,
          documentId: doc.id,
          title: doc.title,
          pages: cached.pages,
          ...(focusPages.length < cached.pages.length ? { focusPages } : {}),
          tokenCount: null,
          source: { kind: 'base64', data: Buffer.from(cached.bytes).toString('base64') },
        });
      }
    }
  }
  return refs;
}

/** Splits a run into ≤ 60-page slices; an edge slice holding only a context page joins its neighbor instead. */
function topicChunks(run: PageSpan, focus: readonly number[]): PageSpan[] {
  const chunks = splitSpan(run.start, run.end, TOPIC_SLICE_PAGES);
  const hasFocus = (c: PageSpan) => focus.some((p) => p >= c.start && p <= c.end);
  if (chunks.length > 1 && !hasFocus(chunks[chunks.length - 1]!)) {
    const tail = chunks.pop()!;
    chunks[chunks.length - 1]!.end = tail.end;
  }
  if (chunks.length > 1 && !hasFocus(chunks[0]!)) {
    const head = chunks.shift()!;
    chunks[0]!.start = head.start;
  }
  return chunks;
}

export function labelMapOf(refs: readonly SliceRef[]): LabelMap {
  const labels: Record<string, string> = {};
  const allowedPages: Record<string, number[]> = {};
  refs.forEach((ref, index) => {
    labels[`D${index + 1}`] = ref.documentId;
    allowedPages[`D${index + 1}`] = [...ref.pages];
  });
  return { labels, allowedPages };
}

function topicInput(bundle: TopicBundle) {
  return {
    title: bundle.title,
    summary: bundle.summary,
    objectives: bundle.objectives,
    concepts: bundle.concepts.map((c) => ({ key: c.key, title: c.title, keyTerms: c.keyTerms, formulas: c.formulas })),
  };
}

export function contentLanguageOf(bundle: TopicBundle, documentLanguage: string | null): string {
  return bundle.subject.contentLanguage ?? documentLanguage ?? 'pt-BR';
}

// ---------------------------------------------------------------- question bank in parallel parts

/**
 * A topic's ~15 questions are written by up to this many calls at once, each with its share of the quotas and of the
 * concepts. One call writing all of them (~20k output tokens) took 60–85 s and was the last thing a material waited
 * on; a part takes about a third of that.
 */
export const QUESTION_PARTS_MAX = 3;

/** Relative output size of a question type (a multiple choice carries a rationale per option), to balance the parts. */
const QUESTION_WEIGHT: Partial<Record<QuestionType, number>> = { mcq_single: 3, multi_select: 3, essay_question: 3, short_answer: 2, matching: 2, ordering: 2 };

export interface QuestionPart {
  index: number;
  of: number;
  quotas: QuotaMap;
  /** Concept keys this part covers (empty when the bank is one part). */
  focusConceptKeys: string[];
}

/**
 * The parts of a topic's bank: one per concept up to QUESTION_PARTS_MAX, concepts dealt in map order and question
 * slots dealt heaviest first, so the parts are about the same size and never ask for the same concept twice.
 */
export function questionParts(bundle: Pick<TopicBundle, 'concepts'>, quotas: QuotaMap): QuestionPart[] {
  const of = Math.max(1, Math.min(QUESTION_PARTS_MAX, bundle.concepts.length));
  if (of === 1) return [{ index: 0, of: 1, quotas, focusConceptKeys: [] }];
  const parts: QuestionPart[] = Array.from({ length: of }, (_v, index) => ({ index, of, quotas: {}, focusConceptKeys: [] }));
  const slots = Object.entries(quotas)
    .flatMap(([type, n]) => Array.from({ length: n ?? 0 }, () => type as QuestionType))
    .sort((a, b) => (QUESTION_WEIGHT[b] ?? 1) - (QUESTION_WEIGHT[a] ?? 1));
  slots.forEach((type, i) => {
    const q = parts[i % of]!.quotas;
    q[type] = (q[type] ?? 0) + 1;
  });
  bundle.concepts.forEach((c, i) => parts[i % of]!.focusConceptKeys.push(c.key));
  return parts;
}

/** The topic's bank quotas (PRA-01.4), split into parts. */
export function topicQuestionParts(bundle: Pick<TopicBundle, 'concepts'>): QuestionPart[] {
  return questionParts(bundle, topicQuotas({ quantitative: isQuantitativeTopic(bundle) }));
}

/**
 * Parts of the topic's bank not written yet, so a resumed or retried topic writes only those: a part is written when
 * one of the topic's generated questions covers one of its concepts.
 */
export async function missingQuestionParts(sql: Sql, bundle: TopicBundle): Promise<number[]> {
  const parts = topicQuestionParts(bundle);
  const { rows } = await sql.query<{ concept_ids: string[] | null }>(
    `select concept_ids from public.questions
      where node_id = $1 and origin = 'generated' and deleted_at is null and status = 'active' and type not in ('find_error','problem')`,
    [bundle.topicId],
  );
  if (rows.length === 0) return parts.map((p) => p.index);
  if (parts.length === 1) return [];
  const covered = new Set(rows.flatMap((r) => r.concept_ids ?? []));
  return parts
    .filter((p) => !p.focusConceptKeys.some((key) => covered.has(bundle.conceptIdByKey.get(key) ?? '')))
    .map((p) => p.index);
}

export interface BuiltKindCall {
  kind: TopicKind;
  taskId: string;
  call: TaskCall<unknown>;
  refs: SliceRef[];
  promptVersion: string;
}

/**
 * Builds the call for one kind. `refs` come from topicSliceRefs (all sources for S4; the current upload's
 * sources for S2). `budget` is the ctx of the call (ai_usage attribution). `part` picks one part of the question
 * bank (topicQuestionParts).
 */
export async function buildKindCall(
  env: PipelineEnv,
  bundle: TopicBundle,
  kind: TopicKind,
  refs: readonly SliceRef[],
  budget: BudgetContext,
  languageOf: string,
  part?: number,
): Promise<BuiltKindCall> {
  const slices: PdfSlice[] = toPdfSlices(refs);
  const languageSubject = bundle.subject.isLanguageSubject;
  const sqlDb: Sql = env.ctx.sql;
  const existing = await existingItems(sqlDb, bundle, kind);
  const quantitative = bundle.concepts.some((c) => c.formulas.length > 0);
  const contentLanguage = languageOf;
  const taskId = TASK_FOR_KIND[kind];
  let built;
  switch (kind) {
    case 'concepts':
      built = getTask(taskId).build({
        topic: { key: 't1', title: bundle.title, summary: bundle.summary, objectives: bundle.objectives },
        siblingTitles: bundle.siblingTitles,
        existingConceptTitles: bundle.concepts.map((c) => c.title),
        slices,
        contentLanguage,
        languageSubject,
      });
      break;
    case 'tldr':
      built = getTask(taskId).build({ topic: topicInput(bundle), slices, contentLanguage, languageSubject });
      break;
    case 'study':
      built = getTask(taskId).build({
        topic: topicInput(bundle),
        siblingTitles: bundle.siblingTitles,
        hasFormulas: quantitative,
        slices,
        contentLanguage,
        languageSubject,
      });
      break;
    case 'deep':
      built = getTask(taskId).build({ topic: topicInput(bundle), slices, contentLanguage, languageSubject });
      break;
    case 'glossary':
      built = getTask(taskId).build({
        topicTitle: bundle.title,
        keyTerms: glossaryTerms(bundle),
        slices,
        contentLanguage,
        languageSubject,
      });
      break;
    case 'cards':
      built = getTask(taskId).build({
        topic: topicInput(bundle),
        slices,
        existingFronts: existing,
        targetCount: cardTargetCount(bundle.concepts.length),
        contentLanguage,
        languageSubject,
      });
      break;
    case 'questions': {
      const parts = topicQuestionParts(bundle);
      const share = parts[part ?? 0] ?? parts[0]!;
      built = getTask(taskId).build({
        topic: topicInput(bundle),
        slices,
        quotas: share.quotas,
        existingStems: existing,
        quantitative,
        ...(share.of > 1 ? { focusConceptKeys: share.focusConceptKeys } : {}),
        contentLanguage,
        languageSubject,
      });
      break;
    }
    case 'feed':
      built = getTask(taskId).build({
        topic: topicInput(bundle),
        slices,
        figurePages: await figurePagesOf(sqlDb, bundle),
        existingTitles: existing,
        contentLanguage,
        languageSubject,
      });
      break;
    case 'find_error':
      built = getTask(taskId).build({ topic: topicInput(bundle), slices, existingStatements: existing, contentLanguage, languageSubject });
      break;
    case 'problems':
      built = getTask(taskId).build({
        topic: topicInput(bundle),
        slices,
        count: problemCountFor(bundle),
        existingStatements: existing,
        contentLanguage,
        languageSubject,
      });
      break;
  }
  // Every kind but `concepts` (which creates the keys) must use the topic's concept keys: sent as an enum.
  const conceptKeys = kind === 'concepts' ? [] : bundle.concepts.map((c) => c.key);
  const prepared = prepareCall(taskId, built, budget, refs, conceptKeys.length ? { concept: conceptKeys } : {});
  return { kind, taskId, call: prepared.call, refs: [...refs], promptVersion: built.promptVersion };
}

/** GlossaryTerms holds 40 terms: the listed ones stay well under it, so the model has room for central extras. */
const GLOSSARY_INPUT_TERMS = 30;

/** Key terms of the topic's concepts, first occurrence of each normalized term only, capped. */
function glossaryTerms(bundle: TopicBundle): Array<{ term: string; conceptKey: string }> {
  const seen = new Set<string>();
  const out: Array<{ term: string; conceptKey: string }> = [];
  for (const concept of bundle.concepts) {
    for (const term of concept.keyTerms) {
      const key = normalizeTerm(term);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ term, conceptKey: concept.key });
    }
  }
  return out.slice(0, GLOSSARY_INPUT_TERMS);
}

async function existingItems(sql: Sql, bundle: TopicBundle, kind: TopicKind): Promise<string[]> {
  if (kind === 'cards') {
    const { rows } = await sql.query<{ front: string }>(
      `select front from public.cards where subject_id = $1 and deleted_at is null and status = 'active' limit 300`,
      [bundle.subjectId],
    );
    return rows.map((r) => r.front);
  }
  if (kind === 'questions') {
    const { rows } = await sql.query<{ stem: string }>(
      `select stem from public.questions where node_id = $1 and deleted_at is null and type not in ('find_error','problem') limit 200`,
      [bundle.topicId],
    );
    return rows.map((r) => r.stem);
  }
  if (kind === 'find_error') {
    const { rows } = await sql.query<{ text: string }>(
      `select coalesce(string_agg(seg->>'text', ' '), '') as text
         from public.questions q, jsonb_array_elements(q.payload->'segments') seg
        where q.node_id = $1 and q.type = 'find_error' and q.deleted_at is null
        group by q.id limit 60`,
      [bundle.topicId],
    );
    return rows.map((r) => r.text.slice(0, 300));
  }
  if (kind === 'problems') {
    const { rows } = await sql.query<{ stem: string }>(
      `select stem from public.questions where node_id = $1 and type = 'problem' and deleted_at is null limit 60`,
      [bundle.topicId],
    );
    return rows.map((r) => r.stem);
  }
  if (kind === 'feed') {
    const { rows } = await sql.query<{ title: string }>(
      `select content->>'title' as title from public.feed_items
        where node_id = $1 and deleted_at is null and status = 'active' and personal_for_user_id is null
          and content->>'title' is not null
        limit 100`,
      [bundle.topicId],
    );
    return rows.map((r) => r.title);
  }
  return [];
}

async function figurePagesOf(sql: Sql, bundle: TopicBundle): Promise<number[]> {
  const pages = new Set<number>();
  for (const source of bundle.sources) {
    const { rows } = await sql.query<{ page_number: number }>(
      `select page_number from public.document_pages
        where document_id = $1 and has_images and page_number between $2 and $3 order by page_number`,
      [source.documentId, source.pageStart, source.pageEnd],
    );
    for (const r of rows) pages.add(r.page_number);
  }
  return [...pages].sort((a, b) => a - b).slice(0, 3);
}

export function budgetForTopic(
  bundle: TopicBundle,
  opts: { jobId: string | null; userId: string | null; kind: TopicKind; documentId: string | null },
): BudgetContext {
  const feature = featureOf(opts.kind);
  return budgetFor(
    { subjectId: bundle.subjectId, ownerClassGroupId: bundle.subject.ownerClassGroupId, uploadedBy: opts.userId, documentId: opts.documentId },
    { jobId: opts.jobId, feature, nodeId: bundle.topicId, userId: opts.userId },
  );
}

export function featureOf(kind: TopicKind): string {
  switch (kind) {
    case 'concepts':
      return 'ING-03';
    case 'tldr':
    case 'study':
    case 'glossary':
      return 'LRN-01';
    case 'deep':
      return 'LRN-01.4';
    case 'cards':
      return 'MEM-01';
    case 'questions':
      return 'PRA-01';
    case 'feed':
      return 'FED-01';
    case 'find_error':
      return 'PRA-06';
    case 'problems':
      return 'PRA-08';
  }
}

/** PRA-08.1: a quantitative topic is one whose concepts carry formulas. */
export function isQuantitativeTopic(bundle: Pick<TopicBundle, 'concepts'>): boolean {
  return bundle.concepts.some((c) => c.formulas.length > 0);
}

/** PRA-08.1: 5–10 problems, one more per concept beyond four. */
export function problemCountFor(bundle: Pick<TopicBundle, 'concepts'>): number {
  return Math.min(10, Math.max(5, bundle.concepts.length + 2));
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

export interface WriteContext {
  pool: pg.Pool;
  bundle: TopicBundle;
  /** Requester (notes.created_by is not null). */
  createdBy: string;
  labels: LabelMap;
  promptVersion: string;
  genBatchId: string;
  language: string;
  /** Replace existing generated rows of this kind (regeneration). */
  force: boolean;
}

/** Concept rows (S2). Duplicate normalized titles keep the existing concept and add the sources (ING-03.11). */
export async function writeConcepts(
  ctx: WriteContext,
  data: {
    concepts: Array<{ key: string; title: string; summary: string; page_start: number; page_end: number; key_terms: string[]; formulas: Array<{ latex: string; description: string }> }>;
    study_minutes?: number;
  },
  existingTitles: Map<string, string>,
): Promise<{ written: number; dropped: number }> {
  let written = 0;
  let dropped = 0;
  const allowed = labelMapAllowed(ctx.labels);
  await withTransaction(ctx.pool, async (client) => {
    if (typeof data.study_minutes === 'number' && data.study_minutes > 0) await writeStudyEstimate(client, ctx, data.study_minutes);
    let position = (await client.query<{ n: number }>(
      `select coalesce(max(position) + 1, 0) as n from public.knowledge_nodes where parent_id = $1 and kind = 'concept' and deleted_at is null`,
      [ctx.bundle.topicId],
    )).rows[0]?.n ?? 0;
    for (const concept of data.concepts) {
      const docId = documentForPages(allowed, concept.page_start, concept.page_end);
      if (!docId) {
        dropped++;
        continue;
      }
      const normalized = normalizeTerm(concept.title);
      const existingId = existingTitles.get(normalized);
      if (existingId) {
        await addSource(client, existingId, docId, concept.page_start, concept.page_end);
        continue;
      }
      const id = uuidV7();
      await client.query(
        `insert into public.knowledge_nodes
           (id, subject_id, parent_id, kind, title, summary, position, key_terms, formulas, origin_document_id)
         values ($1, $2, $3, 'concept', $4, $5, $6, $7, $8::jsonb, $9)`,
        [
          id,
          ctx.bundle.subjectId,
          ctx.bundle.topicId,
          concept.title,
          concept.summary,
          position++,
          concept.key_terms,
          JSON.stringify(concept.formulas),
          docId,
        ],
      );
      await addSource(client, id, docId, concept.page_start, concept.page_end);
      existingTitles.set(normalized, id);
      written++;
    }
  });
  return { written, dropped };
}

function labelMapAllowed(labels: LabelMap): Array<{ doc: string; documentId: string; pages: readonly number[] }> {
  return Object.keys(labels.labels).map((label) => ({
    doc: label,
    documentId: labels.labels[label] as string,
    pages: labels.allowedPages[label] ?? [],
  }));
}

function documentForPages(allowed: ReadonlyArray<{ documentId: string; pages: readonly number[] }>, start: number, end: number): string | null {
  for (const entry of allowed) {
    if (entry.pages.includes(start) && entry.pages.includes(end)) return entry.documentId;
  }
  return null;
}

/**
 * The topic's study minutes for the documents of this call (GOL-04 §8.2.2), split by their share of the pages sent,
 * and the cached total on knowledge_nodes.est_learn_minutes. A later estimate for the same document replaces it.
 */
async function writeStudyEstimate(sql: Sql, ctx: WriteContext, minutes: number): Promise<void> {
  const byDoc = new Map<string, number>();
  for (const [label, documentId] of Object.entries(ctx.labels.labels)) {
    byDoc.set(documentId, (byDoc.get(documentId) ?? 0) + (ctx.labels.allowedPages[label]?.length ?? 0));
  }
  const totalPages = [...byDoc.values()].reduce((a, b) => a + b, 0);
  for (const [documentId, pages] of byDoc) {
    const share = totalPages > 0 ? pages / totalPages : 1 / byDoc.size;
    await sql.query(
      `insert into public.topic_study_estimates (node_id, document_id, minutes, prompt_version) values ($1, $2, $3, $4)
       on conflict (node_id, document_id) do update set minutes = excluded.minutes, prompt_version = excluded.prompt_version`,
      [ctx.bundle.topicId, documentId, Math.max(1, Math.round(minutes * share)), ctx.promptVersion],
    );
  }
  await sql.query(
    `update public.knowledge_nodes set est_learn_minutes = (select sum(minutes) from public.topic_study_estimates where node_id = $1)
      where id = $1`,
    [ctx.bundle.topicId],
  );
}

async function addSource(sql: Sql, nodeId: string, documentId: string, pageStart: number, pageEnd: number): Promise<void> {
  await sql.query(
    `insert into public.node_sources (node_id, document_id, page_start, page_end, origin)
     values ($1, $2, $3, $4, 'ai') on conflict (node_id, document_id, page_start, page_end) do nothing`,
    [nodeId, documentId, pageStart, pageEnd],
  );
}

/** Note with inline citation markers (spec 02 §7; ai-pipeline §5.2). Notes table added by a later migration. */
export async function writeNote(
  ctx: WriteContext,
  depth: 'tldr' | 'study' | 'deep',
  text: string,
  citations: readonly MappedCitation[],
): Promise<{ written: boolean }> {
  if (!(await tableExists(ctx.pool, 'public.notes'))) return { written: false };
  const inputs: CitationInput[] = citations.map((c) => ({
    textStart: c.textStart,
    textEnd: c.textEnd,
    documentId: c.documentId,
    pageStart: c.pageStart,
    pageEnd: c.pageEnd,
    citedText: c.citedText,
    valid: c.valid,
  }));
  const rendered = renderCitedBody(text, inputs);
  const body = rendered.body.trim();
  let written = true;
  await withTransaction(ctx.pool, async (client) => {
    if (ctx.force) {
      await client.query(
        `update public.notes set status = 'superseded', updated_at = now()
          where node_id = $1 and depth = $2 and status in ('pending','generating','ready') and deleted_at is null`,
        [ctx.bundle.topicId, depth],
      );
    } else {
      // One current note per topic and depth. A ready one stays (a retried wave writes nothing twice); a pending
      // or generating one belongs to note-generate, which finishes that row itself.
      const current = await client.query(
        `select 1 from public.notes
          where node_id = $1 and depth = $2 and status in ('pending','generating','ready') and deleted_at is null`,
        [ctx.bundle.topicId, depth],
      );
      if ((current.rowCount ?? 0) > 0) {
        written = false;
        return;
      }
    }
    await client.query(
      `insert into public.notes
         (subject_id, node_id, scope_kind, depth, body, citations, language, word_count, has_math, status,
          low_citation_coverage, version, prompt_version, gen_batch_id, created_by)
       values ($1, $2, 'topic', $3, $4, $5::jsonb, $6, $7, $8, 'ready', $9, 1, $10, $11, $12)`,
      [
        ctx.bundle.subjectId,
        ctx.bundle.topicId,
        depth,
        body,
        JSON.stringify(rendered.citations),
        ctx.language,
        body.split(/\s+/).filter(Boolean).length,
        body.includes('$'),
        rendered.citations.length === 0,
        ctx.promptVersion,
        ctx.genBatchId,
        ctx.createdBy,
      ],
    );
  });
  return { written };
}

export async function writeGlossary(
  ctx: WriteContext,
  data: { terms: Array<{ term: string; definition: string; example: string | null; aliases: string[]; concept_key: string; source_pages: Array<{ doc: string; page_start: number; page_end: number }> }> },
): Promise<{ written: number; dropped: number }> {
  if (!(await tableExists(ctx.pool, 'public.glossary_terms'))) return { written: 0, dropped: 0 };
  let written = 0;
  let dropped = 0;
  await withTransaction(ctx.pool, async (client) => {
    if (ctx.force) {
      await client.query(
        `update public.glossary_terms set deleted_at = now() where node_id = $1 and deleted_at is null and prompt_version is not null`,
        [ctx.bundle.topicId],
      );
    }
    for (const term of data.terms) {
      const mapped = mapGlossaryTerm(
        { ...(term as GlossaryDraftInput) },
        { labels: ctx.labels, conceptIdByKey: ctx.bundle.conceptIdByKey, topicId: ctx.bundle.topicId },
      );
      if (!mapped.ok) {
        dropped++;
        continue;
      }
      const row = mapped.value;
      // normalized_term is a generated column in the table; the unique index on it gives the conflict target.
      const result = await client.query(
        `insert into public.glossary_terms
           (subject_id, node_id, term, aliases, definition, example, source_pages, prompt_version)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         on conflict (subject_id, normalized_term) where deleted_at is null do nothing`,
        [ctx.bundle.subjectId, row.node_id, row.term, row.aliases, row.definition, row.example, JSON.stringify(row.source_pages), ctx.promptVersion],
      );
      written += result.rowCount ?? 0;
    }
  });
  return { written, dropped };
}

export async function writeCards(
  ctx: WriteContext,
  data: { cards: CardDraftInput[] },
  existingFronts: ReadonlySet<string>,
): Promise<{ written: number; dropped: number }> {
  let written = 0;
  let dropped = 0;
  const seen = new Set<string>(existingFronts);
  await withTransaction(ctx.pool, async (client) => {
    if (ctx.force) {
      await client.query(
        `update public.cards set status = 'archived', updated_at = now()
          where node_id = $1 and origin = 'generated' and deleted_at is null and status = 'active'`,
        [ctx.bundle.topicId],
      );
    }
    for (const draft of data.cards) {
      const key = cardFrontKey(draft.front);
      if (seen.has(key)) {
        dropped++;
        continue;
      }
      const mapped = mapCard(draft, { labels: ctx.labels, conceptIdByKey: ctx.bundle.conceptIdByKey });
      if (!mapped.ok) {
        dropped++;
        continue;
      }
      seen.add(key);
      const groupId = mapped.value.some((r) => r.sibling_key !== null) ? uuidV7() : null;
      for (const row of mapped.value) {
        await client.query(
          `insert into public.cards
             (subject_id, node_id, concept_id, type, front, back, source_pages, origin, sibling_group_id, cloze_index,
              has_math, prompt_version, gen_batch_id)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, 'generated', $8, $9, $10, $11, $12)`,
          [
            ctx.bundle.subjectId,
            ctx.bundle.topicId,
            row.concept_id,
            row.type,
            row.front,
            row.back,
            JSON.stringify(row.source_pages),
            row.sibling_key !== null ? groupId : null,
            row.cloze_index,
            row.has_math,
            ctx.promptVersion,
            ctx.genBatchId,
          ],
        );
        written++;
      }
    }
  });
  return { written, dropped };
}

export async function writeQuestions(
  ctx: WriteContext,
  data: { questions: ModelQuestionDraft[] },
): Promise<{ written: number; dropped: number; reasons: Record<string, number> }> {
  let written = 0;
  let dropped = 0;
  const reasons: Record<string, number> = {};
  await withTransaction(ctx.pool, async (client) => {
    if (ctx.force) {
      // Only earlier generations: the other parts of this one (same gen_batch_id) are kept.
      await client.query(
        `update public.questions set status = 'archived', updated_at = now()
          where node_id = $1 and origin = 'generated' and deleted_at is null and status = 'active'
            and type not in ('find_error','problem') and gen_batch_id is distinct from $2::uuid`,
        [ctx.bundle.topicId, ctx.genBatchId],
      );
    }
    for (const raw of data.questions) {
      const decoded = decodeQuestion(raw);
      if (!decoded.ok) {
        dropped++;
        reasons[decoded.reason] = (reasons[decoded.reason] ?? 0) + 1;
        continue;
      }
      const draft = decoded.question as QuestionDraft;
      const mapped = mapQuestion(draft, {
        labels: ctx.labels,
        conceptIdByKey: ctx.bundle.conceptIdByKey,
      });
      if (!mapped.ok) {
        dropped++;
        reasons[mapped.reason] = (reasons[mapped.reason] ?? 0) + 1;
        continue;
      }
      const row = mapped.value;
      try {
        // The contract grading reads at answer time (somatória values, absolute alternatives…): a row it
        // rejects would only fail when a student answers it.
        parseQuestionPayload(row.type as QuestionType, row.payload);
      } catch {
        dropped++;
        reasons.payload_contract = (reasons.payload_contract ?? 0) + 1;
        continue;
      }
      await client.query(
        `insert into public.questions
           (subject_id, node_id, concept_ids, type, stem, stimulus, payload, explanation, bloom_level, difficulty,
            has_math, source_pages, origin, prompt_version, gen_batch_id, status, review_status)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12::jsonb, 'generated', $13, $14, 'active', 'approved')`,
        [
          ctx.bundle.subjectId,
          ctx.bundle.topicId,
          row.concept_ids,
          row.type,
          row.stem,
          row.stimulus ? JSON.stringify(row.stimulus) : null,
          JSON.stringify(row.payload),
          row.explanation,
          row.bloom_level,
          row.difficulty,
          row.has_math,
          JSON.stringify(row.source_pages),
          ctx.promptVersion,
          ctx.genBatchId,
        ],
      );
      written++;
    }
  });
  return { written, dropped, reasons };
}

async function insertGeneratedQuestion(client: Sql, ctx: WriteContext, row: QuestionRow): Promise<void> {
  await client.query(
    `insert into public.questions
       (subject_id, node_id, concept_ids, type, stem, stimulus, payload, explanation, bloom_level, difficulty,
        has_math, source_pages, origin, prompt_version, gen_batch_id, status, review_status)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12::jsonb, 'generated', $13, $14, 'active', 'approved')`,
    [
      ctx.bundle.subjectId,
      ctx.bundle.topicId,
      row.concept_ids,
      row.type,
      row.stem,
      row.stimulus ? JSON.stringify(row.stimulus) : null,
      JSON.stringify(row.payload),
      row.explanation,
      row.bloom_level,
      row.difficulty,
      row.has_math,
      JSON.stringify(row.source_pages),
      ctx.promptVersion,
      ctx.genBatchId,
    ],
  );
}

async function archiveGenerated(client: Sql, ctx: WriteContext, type: 'find_error' | 'problem'): Promise<void> {
  await client.query(
    `update public.questions set status = 'archived', updated_at = now()
      where node_id = $1 and origin = 'generated' and type = $2 and deleted_at is null and status = 'active'`,
    [ctx.bundle.topicId, type],
  );
}

/** Ache o Erro items (PRA-06.1–06.2). */
export async function writeFindErrors(ctx: WriteContext, data: { items: FindErrorDraft[] }): Promise<{ written: number; dropped: number; reasons: Record<string, number> }> {
  let written = 0;
  let dropped = 0;
  const reasons: Record<string, number> = {};
  await withTransaction(ctx.pool, async (client) => {
    if (ctx.force) await archiveGenerated(client, ctx, 'find_error');
    for (const draft of data.items) {
      const mapped = mapFindError(draft, { labels: ctx.labels, conceptIdByKey: ctx.bundle.conceptIdByKey });
      if (!mapped.ok) {
        dropped++;
        reasons[mapped.reason] = (reasons[mapped.reason] ?? 0) + 1;
        continue;
      }
      await insertGeneratedQuestion(client, ctx, mapped.value);
      written++;
    }
  });
  return { written, dropped, reasons };
}

/**
 * Problem set (PRA-08.1–08.2, 08.6): problems that fail the consistency check are dropped. Items of one set
 * share `set_id`; the first (easiest) carries the faded worked examples shown before the set.
 */
export async function writeProblems(
  ctx: WriteContext,
  data: { worked_examples: WorkedExampleDraft[]; problems: ProblemDraft[] },
): Promise<{ written: number; dropped: number; reasons: Record<string, number> }> {
  let written = 0;
  let dropped = 0;
  const reasons: Record<string, number> = {};
  const rows: QuestionRow[] = [];
  for (const draft of data.problems) {
    const mapped = mapProblem(draft, {
      labels: ctx.labels,
      conceptIdByKey: ctx.bundle.conceptIdByKey,
      consistent: (p) => checkProblemConsistency(p).ok,
    });
    if (!mapped.ok) {
      dropped++;
      reasons[mapped.reason] = (reasons[mapped.reason] ?? 0) + 1;
      continue;
    }
    rows.push(mapped.value);
  }
  rows.sort((a, b) => a.difficulty - b.difficulty);
  const setId = uuidV7();
  const examples = fadeWorkedExamples(data.worked_examples);
  await withTransaction(ctx.pool, async (client) => {
    if (ctx.force) await archiveGenerated(client, ctx, 'problem');
    rows.forEach((row, index) => {
      row.payload = { ...row.payload, set_id: setId, set_position: index, ...(index === 0 && examples.length > 0 ? { worked_examples: examples } : {}) };
    });
    for (const row of rows) {
      await insertGeneratedQuestion(client, ctx, row);
      written++;
    }
  });
  return { written, dropped, reasons };
}

/** Feed items (FED-01, Phase 2 table). Stored as jsonb content per type (spec 06 §8.1). */
export async function writeFeed(
  ctx: WriteContext,
  data: { items: Array<{ type: string; concept_key: string | null; title: string; body: string; formula_latex: string | null; question: unknown; figure_page: number | null; caption: string | null; external_knowledge: boolean; source_pages: Array<{ doc: string; page_start: number; page_end: number }> }> },
): Promise<{ written: number; dropped: number }> {
  if (!(await tableExists(ctx.pool, 'public.feed_items'))) return { written: 0, dropped: 0 };
  let written = 0;
  let dropped = 0;
  await withTransaction(ctx.pool, async (client) => {
    for (const item of data.items) {
      const sources = toSourcePages(item.source_pages, ctx.labels);
      const conceptId = item.concept_key ? ctx.bundle.conceptIdByKey.get(item.concept_key) ?? null : null;
      if (!sources || ((item.type === 'micro_lesson' || item.type === 'quick_question') && !conceptId)) {
        dropped++;
        continue;
      }
      await client.query(
        `insert into public.feed_items
           (subject_id, node_id, concept_id, type, content, source_pages, external_knowledge, prompt_version, gen_batch_id, status)
         values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, 'active')`,
        [
          ctx.bundle.subjectId,
          ctx.bundle.topicId,
          conceptId,
          item.type,
          JSON.stringify({ title: item.title, body: item.body, formula_latex: item.formula_latex, question: item.question, figure_page: item.figure_page, caption: item.caption }),
          JSON.stringify(sources),
          item.external_knowledge,
          ctx.promptVersion,
          ctx.genBatchId,
        ],
      );
      written++;
    }
  });
  return { written, dropped };
}
