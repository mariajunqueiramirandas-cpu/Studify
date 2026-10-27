// Topic content (S2 concepts, S4 notes, glossary, cards, questions, feed): loads a topic's bundle from the
// map, builds the prompts input for each kind, and writes the outputs. Calls are built the same way for the
// Batch path and the standard-API path, so a re-run uses the same prompt bytes (ai-pipeline §6.1).
import { cardTargetCount, decodeQuestion, getTask, topicQuotas, type QuestionDraft as ModelQuestionDraft } from '@studify/prompts';
import type { PdfSlice } from '@studify/prompts';
import { checkProblemConsistency, uuidV7 } from '@studify/shared';
import type { BudgetContext, MappedCitation, TaskCall } from '@studify/ai';
import type pg from 'pg';
import { tableExists, withTransaction, type Sql } from '../framework/db.ts';
import { budgetFor, getDocument, type PipelineEnv } from './env.ts';
import { TASK_FOR_KIND, type TopicKind } from './custom-id.ts';
import { splitSpan } from './slice-plan.ts';
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
 */
export async function topicSliceRefs(env: PipelineEnv, sources: readonly SourceSpan[]): Promise<SliceRef[]> {
  const ordered = [...sources].sort((a, b) => a.documentId.localeCompare(b.documentId) || a.pageStart - b.pageStart);
  const refs: SliceRef[] = [];
  for (const source of ordered) {
    const doc = await getDocument(env, source.documentId);
    if (!doc) throw new Error(`document ${source.documentId} not found for topic slices`);
    for (const span of splitSpan(source.pageStart, source.pageEnd, TOPIC_SLICE_PAGES)) {
      const cached = await env.sources.slice(doc, span, 'topic');
      refs.push({
        id: cached.id,
        documentId: doc.id,
        title: doc.title,
        pages: cached.pages,
        tokenCount: null,
        source: { kind: 'base64', data: Buffer.from(cached.bytes).toString('base64') },
      });
    }
  }
  return refs;
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

export interface BuiltKindCall {
  kind: TopicKind;
  taskId: string;
  call: TaskCall<unknown>;
  refs: SliceRef[];
  promptVersion: string;
}

/**
 * Builds the call for one kind. `refs` come from topicSliceRefs (all sources for S4; the current upload's
 * sources for S2). `budget` is the ctx of the call (ai_usage attribution).
 */
export async function buildKindCall(
  env: PipelineEnv,
  bundle: TopicBundle,
  kind: TopicKind,
  refs: readonly SliceRef[],
  budget: BudgetContext,
  languageOf: string,
): Promise<BuiltKindCall> {
  const slices: PdfSlice[] = toPdfSlices(refs);
  const languageSubject = bundle.subject.isLanguageSubject;
  const sqlDb: Sql = env.ctx.db;
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
        keyTerms: bundle.concepts.flatMap((c) => c.keyTerms.map((term) => ({ term, conceptKey: c.key }))),
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
    case 'questions':
      built = getTask(taskId).build({
        topic: topicInput(bundle),
        slices,
        quotas: topicQuotas({ quantitative }),
        existingStems: existing,
        quantitative,
        contentLanguage,
        languageSubject,
      });
      break;
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
  const prepared = prepareCall(taskId, built, budget, refs);
  return { kind, taskId, call: prepared.call, refs: [...refs], promptVersion: built.promptVersion };
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
    return [];
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
  data: { concepts: Array<{ key: string; title: string; summary: string; page_start: number; page_end: number; key_terms: string[]; formulas: Array<{ latex: string; description: string }> }> },
  existingTitles: Map<string, string>,
): Promise<{ written: number; dropped: number }> {
  let written = 0;
  let dropped = 0;
  const allowed = labelMapAllowed(ctx.labels);
  await withTransaction(ctx.pool, async (client) => {
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
      await client.query(
        `update public.questions set status = 'archived', updated_at = now()
          where node_id = $1 and origin = 'generated' and deleted_at is null and status = 'active'
            and type not in ('find_error','problem')`,
        [ctx.bundle.topicId],
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
