// Trilha content written ahead (TRL-01, spec 14 §7, ADR 0011). While a material is processed, each topic's concepts
// get their lesson with its practice questions (trail.lesson) and what comes after it (trail.reinforce: a
// re-explanation from another angle, fresh questions for after a miss, chapter-test questions), and the subject gets
// its path order (trail.plan). All of it is subject content, charged like notes and cards and shared by every student
// of the subject: a student's trail copies its steps from here (apps/api shared/trail.ts) instead of waiting on a
// model call. What is missing when a student needs it is still written on demand by the API.
import { BudgetExceededError, callClaude, type CallResult } from '@studify/ai';
import { getTask, type BuiltPrompt, type PdfSlice } from '@studify/prompts';
import {
  normalizeTrailPlan,
  taughtBeforeIn,
  trailOutlineHash,
  trailTopicsOf,
  type ProposedChapter,
  type SourcePage,
  type TrailMapNode,
  type TrailOutlineTopic,
  type TrailPrerequisite,
} from '@studify/shared';
import type { OperationContext } from '../framework/types.ts';
import type { Sql } from '../framework/db.ts';
import { budgetFor, createEnv } from '../ingest/env.ts';
import { supabaseStore } from '../ingest/store.ts';
import { contentLanguageOf, labelMapOf, loadTopicBundle, topicSliceRefs, type TopicBundle } from '../ingest/topics.ts';
import { prepareCall, toPdfSlices, type SliceRef } from '../ingest/tasks.ts';
import { toSourcePages, type LabelMap } from '../ingest/mappers.ts';
import { mapLimit } from '../ingest/concurrency.ts';
import { loadSubject, type SubjectRecord } from '../ingest/repo.ts';
import { withShortCache } from './ai-adapter.ts';

const FEATURE = 'TRL-01';
/** Concepts of one topic written at once, after the first one has written the cache the others read. */
const CONCEPT_CONCURRENCY = 3;

// ---------------------------------------------------------------- outline

interface MapNode extends TrailMapNode {
  summary: string | null;
  learning_objectives: string[] | null;
}

export interface SubjectOutline {
  topics: TrailOutlineTopic[];
  prerequisites: TrailPrerequisite[];
  nodes: Map<string, MapNode>;
}

/** The subject's map as the path sees it, before any student's exclusions (trailTopicsOf). */
export async function loadSubjectOutline(sql: Sql, subjectId: string): Promise<SubjectOutline> {
  const [nodes, pages, prereqs] = await Promise.all([
    sql.query<MapNode>(
      `select id, parent_id, kind, title, summary, position, learning_objectives, is_placeholder
         from public.knowledge_nodes where subject_id = $1 and deleted_at is null and hidden_reason is null`,
      [subjectId],
    ),
    sql.query<{ node_id: string }>(
      `select distinct s.node_id from public.node_sources s join public.knowledge_nodes n on n.id = s.node_id
        where n.subject_id = $1 and s.deleted_at is null`,
      [subjectId],
    ),
    sql.query<{ node_id: string; prerequisite_node_id: string }>(
      `select p.node_id, p.prerequisite_node_id from public.node_prerequisites p join public.knowledge_nodes n on n.id = p.node_id
        where n.subject_id = $1 and p.deleted_at is null`,
      [subjectId],
    ),
  ]);
  return {
    topics: trailTopicsOf(nodes.rows, new Set(pages.rows.map((r) => r.node_id))),
    prerequisites: prereqs.rows.map((p) => ({ nodeId: p.node_id, prerequisiteId: p.prerequisite_node_id })),
    nodes: new Map(nodes.rows.map((n) => [n.id, n])),
  };
}

interface StoredPlan {
  outline_hash: string;
  chapters: ProposedChapter[];
}

async function loadSubjectPlan(sql: Sql, subjectId: string): Promise<StoredPlan | null> {
  const { rows } = await sql.query<StoredPlan>(`select outline_hash, chapters from public.trail_subject_plans where subject_id = $1`, [subjectId]);
  return rows[0] ?? null;
}

/** Concepts in teaching order: the subject's path when it has one, else the outline repaired by prerequisites. */
function pathOrder(outline: SubjectOutline, plan: StoredPlan | null): string[] {
  return normalizeTrailPlan(plan?.chapters ?? [], outline.topics, outline.prerequisites).flatMap((ch) => ch.conceptIds);
}

// ---------------------------------------------------------------- path order (trail.plan)

interface PlanOut {
  goal: string;
  chapters: Array<{ topic_key: string; why: string; concept_keys: string[] }>;
}

export type PlanOutcome = 'planned' | 'unchanged' | 'empty' | 'failed' | 'budget';

/**
 * trail.plan for the whole subject (TRL-01.2): the order every student's path starts from. Students' exclusions and
 * finished chapters are applied to it by the API, without another call. Runs again only when the map changed.
 */
export async function planSubject(ctx: OperationContext, input: { subjectId: string; userId: string | null }): Promise<PlanOutcome> {
  const sql = ctx.db;
  const subject = await loadSubject(sql, input.subjectId);
  if (!subject) return 'empty';
  const outline = await loadSubjectOutline(sql, subject.id);
  if (outline.topics.length === 0) return 'empty';
  const hash = trailOutlineHash(outline.topics);
  if ((await loadSubjectPlan(sql, subject.id))?.outline_hash === hash) return 'unchanged';

  const sorted = [...outline.topics].sort((a, b) => a.order - b.order);
  const topicKey = new Map<string, string>();
  const conceptKey = new Map<string, string>();
  const fromKey = new Map<string, string>();
  let c = 0;
  sorted.forEach((t, i) => {
    topicKey.set(t.id, `T${i + 1}`);
    fromKey.set(`T${i + 1}`, t.id);
    for (const concept of t.concepts) {
      c += 1;
      conceptKey.set(concept.id, `C${c}`);
      fromKey.set(`C${c}`, concept.id);
    }
  });
  const keyOf = (id: string) => topicKey.get(id) ?? conceptKey.get(id);
  const units: Array<{ title: string | null; topics: Array<Record<string, unknown>> }> = [];
  for (const t of sorted) {
    const node = outline.nodes.get(t.id);
    const parent = node?.parent_id ? outline.nodes.get(node.parent_id) : undefined;
    const unitTitle = parent && parent.kind === 'unit' ? parent.title : null;
    if (units.length === 0 || units.at(-1)!.title !== unitTitle) units.push({ title: unitTitle, topics: [] });
    units.at(-1)!.topics.push({
      key: topicKey.get(t.id),
      title: t.title,
      summary: node?.summary ?? null,
      objectives: node?.learning_objectives ?? [],
      concepts: [...t.concepts].sort((a, b) => a.order - b.order).map((x) => ({ key: conceptKey.get(x.id), title: x.title })),
    });
  }
  const needs = new Map<string, Set<string>>();
  for (const e of outline.prerequisites) {
    const a = keyOf(e.nodeId);
    const b = keyOf(e.prerequisiteId);
    if (a && b && a !== b) needs.set(a, (needs.get(a) ?? new Set()).add(b));
  }

  const task = getTask('trail.plan');
  const built = task.build({
    subjectName: subject.name,
    units,
    prerequisites: [...needs.entries()].map(([key, set]) => ({ key, needs: [...set].sort() })),
    alreadyDone: [],
    contentLanguage: subject.contentLanguage ?? 'pt-BR',
    languageSubject: subject.isLanguageSubject,
  });
  const budget = budgetOf(subject, input.userId, null);
  let result: CallResult<unknown>;
  try {
    result = await callClaude(ctx.ai, withShortCache(prepareCall('trail.plan', built, budget, [], { topic: [...topicKey.values()], concept: [...conceptKey.values()] }).call));
  } catch (err) {
    if (err instanceof BudgetExceededError) return 'budget';
    throw err;
  }
  if (result.status !== 'ok') {
    // The API keeps the outline order until a later material runs this again.
    ctx.log.warn({ subjectId: subject.id, status: result.status }, 'trail.plan: no plan');
    return 'failed';
  }
  const out = result.data as PlanOut;
  const proposed: ProposedChapter[] = out.chapters
    .map((ch) => ({ topicId: fromKey.get(ch.topic_key) ?? '', why: ch.why, conceptIds: ch.concept_keys.map((k) => fromKey.get(k) ?? '') }))
    .filter((ch) => ch.topicId);
  const chapters = normalizeTrailPlan(proposed, sorted, outline.prerequisites);
  await sql.query(
    `insert into public.trail_subject_plans (subject_id, outline_hash, goal, chapters, prompt_version) values ($1, $2, $3, $4, $5)
     on conflict (subject_id) do update set outline_hash = excluded.outline_hash, goal = excluded.goal, chapters = excluded.chapters,
       prompt_version = excluded.prompt_version`,
    [subject.id, hash, out.goal, JSON.stringify(chapters), task.promptVersion],
  );
  return 'planned';
}

// ---------------------------------------------------------------- concept content (trail.lesson, trail.reinforce)

interface ModelQuestion {
  stem: string;
  options: Array<{ id: string; text: string; rationale: string }>;
  correct: string;
  explanation: string;
  tip: string | null;
  terms: Array<{ term: string; definition: string }>;
  source_pages: Array<{ doc: string; page_start: number; page_end: number }>;
}

interface ModelLesson {
  title: string;
  body: string;
  terms: Array<{ term: string; definition: string }>;
  source_pages: ModelQuestion['source_pages'];
}

export interface BankQuestion extends Omit<ModelQuestion, 'source_pages'> {
  source_pages: SourcePage[];
}

export interface BankLesson extends Omit<ModelLesson, 'source_pages'> {
  source_pages: SourcePage[];
}

const pagesOf = (refs: ModelLesson['source_pages'], labels: LabelMap): SourcePage[] => toSourcePages(refs, labels) ?? [];
const bankLesson = (l: ModelLesson, labels: LabelMap): BankLesson => ({ title: l.title, body: l.body, terms: l.terms, source_pages: pagesOf(l.source_pages, labels) });
const bankQuestion = (q: ModelQuestion, labels: LabelMap): BankQuestion => ({
  stem: q.stem,
  options: q.options,
  correct: q.correct,
  explanation: q.explanation,
  tip: q.tip,
  terms: q.terms,
  source_pages: pagesOf(q.source_pages, labels),
});

function budgetOf(subject: SubjectRecord, userId: string | null, nodeId: string | null) {
  return budgetFor(
    { subjectId: subject.id, ownerClassGroupId: subject.ownerClassGroupId, uploadedBy: userId ?? subject.createdBy },
    { jobId: null, feature: FEATURE, nodeId, userId },
  );
}

/** A topic without concepts is taught as one concept: itself (the API does the same). */
function conceptsOf(bundle: TopicBundle) {
  if (bundle.concepts.length === 0) return [{ key: bundle.topicId, title: bundle.title, summary: bundle.summary, keyTerms: [] as string[] }];
  return bundle.concepts.map((c) => ({ key: c.id, title: c.title, summary: c.summary, keyTerms: c.keyTerms }));
}

export interface TopicContentOutcome {
  /** Concepts whose lesson or reinforcement was written by this run. */
  written: number;
  failed: number;
  budget: boolean;
}

/**
 * Writes what the topic's concepts still lack (spec 14 §7): a concept without content gets trail.lesson and then
 * trail.reinforce, one that has its lesson but not its reinforcement only the latter. Rows already complete are left
 * alone, so running this again (a resumed material, a regenerated topic, a student opening an older subject) only
 * pays for what is missing.
 */
export async function prepareTopicContent(ctx: OperationContext, input: { topicId: string; userId: string | null }): Promise<TopicContentOutcome> {
  const outcome: TopicContentOutcome = { written: 0, failed: 0, budget: false };
  const sql = ctx.db;
  const bundle = await loadTopicBundle(sql, input.topicId);
  if (!bundle || bundle.sources.length === 0) return outcome;
  const concepts = conceptsOf(bundle);
  const existing = await sql.query<{ concept_id: string; lesson: BankLesson; practice: BankQuestion[]; reinforced: boolean }>(
    `select concept_id, lesson, practice, remedial_lesson is not null as reinforced from public.trail_concept_content where concept_id = any($1::uuid[])`,
    [concepts.map((c) => c.key)],
  );
  const have = new Map(existing.rows.map((r) => [r.concept_id, r]));
  const todo = concepts.filter((c) => !have.get(c.key)?.reinforced);
  if (todo.length === 0) return outcome;

  const env = createEnv(ctx, supabaseStore(ctx.supabase));
  const refs: SliceRef[] = await topicSliceRefs(env, bundle.sources);
  if (refs.length === 0) return outcome;
  const slices: PdfSlice[] = toPdfSlices(refs);
  const labels = labelMapOf(refs);
  const outline = await loadSubjectOutline(sql, bundle.subjectId);
  const order = pathOrder(outline, await loadSubjectPlan(sql, bundle.subjectId));
  const titleOf = (id: string) => outline.nodes.get(id)?.title;
  const budget = budgetOf(bundle.subject, input.userId, bundle.topicId);
  const base = {
    topic: {
      title: bundle.title,
      summary: bundle.summary,
      objectives: bundle.objectives,
      concepts: bundle.concepts.map((c) => ({ key: c.id, title: c.title, keyTerms: c.keyTerms, formulas: c.formulas })),
    },
    slices,
    contentLanguage: contentLanguageOf(bundle, null),
    languageSubject: bundle.subject.isLanguageSubject,
  };

  /** One structured call; null when it produced nothing usable. A budget refusal stops the rest of the topic. */
  const call = async (taskId: 'trail.lesson' | 'trail.reinforce', built: BuiltPrompt): Promise<unknown> => {
    if (outcome.budget) return null;
    try {
      const result = await callClaude(ctx.ai, withShortCache(prepareCall(taskId, built, budget, refs).call));
      if (result.status === 'ok') return result.data;
      ctx.log.warn({ topicId: bundle.topicId, taskId, status: result.status }, 'trail content: no output');
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        outcome.budget = true;
        return null;
      }
      ctx.log.warn({ topicId: bundle.topicId, taskId, err: err instanceof Error ? err.message : String(err) }, 'trail content: call failed');
    }
    return null;
  };

  const writeConcept = async (concept: ReturnType<typeof conceptsOf>[number]): Promise<void> => {
    const taughtBefore = taughtBeforeIn(order, concept.key, titleOf);
    let row = have.get(concept.key);
    let wrote = false;
    if (!row) {
      const task = getTask('trail.lesson');
      const data = (await call('trail.lesson', task.build({ ...base, concept, taughtBefore }))) as { lesson: ModelLesson; questions: ModelQuestion[] } | null;
      if (!data) {
        if (!outcome.budget) outcome.failed += 1;
        return;
      }
      const lesson = bankLesson(data.lesson, labels);
      const practice = data.questions.map((q) => bankQuestion(q, labels));
      // A concept the API wrote meanwhile (a student got there first) keeps that version.
      await sql.query(
        `insert into public.trail_concept_content (concept_id, topic_id, subject_id, lesson, practice, prompt_version)
         values ($1, $2, $3, $4, $5, $6) on conflict (concept_id) do nothing`,
        [concept.key, bundle.topicId, bundle.subjectId, JSON.stringify(lesson), JSON.stringify(practice), task.promptVersion],
      );
      const stored = await sql.query<{ lesson: BankLesson; practice: BankQuestion[] }>(`select lesson, practice from public.trail_concept_content where concept_id = $1`, [concept.key]);
      row = { concept_id: concept.key, lesson: stored.rows[0]?.lesson ?? lesson, practice: stored.rows[0]?.practice ?? practice, reinforced: false };
      wrote = true;
    }
    const task = getTask('trail.reinforce');
    const data = (await call(
      'trail.reinforce',
      task.build({ ...base, concept, taughtBefore, lesson: { title: row.lesson.title, body: row.lesson.body }, askedStems: row.practice.map((q) => q.stem) }),
    )) as { lesson: ModelLesson; remedial_questions: ModelQuestion[]; test_questions: ModelQuestion[] } | null;
    if (data) {
      await sql.query(
        `update public.trail_concept_content set remedial_lesson = $2, remedial_questions = $3, test_questions = $4, reinforce_prompt_version = $5
          where concept_id = $1 and remedial_lesson is null`,
        [
          concept.key,
          JSON.stringify(bankLesson(data.lesson, labels)),
          JSON.stringify(data.remedial_questions.map((q) => bankQuestion(q, labels))),
          JSON.stringify(data.test_questions.map((q) => bankQuestion(q, labels))),
          task.promptVersion,
        ],
      );
      wrote = true;
    } else if (!outcome.budget) {
      outcome.failed += 1;
    }
    if (wrote) outcome.written += 1;
  };

  // In path order, so the concepts a student reaches first are written first.
  const ordered = [...todo].sort((a, b) => indexIn(order, a.key) - indexIn(order, b.key));
  await writeConcept(ordered[0]!);
  await mapLimit(ordered.slice(1), CONCEPT_CONCURRENCY, writeConcept);
  ctx.log.info({ topicId: bundle.topicId, ...outcome }, 'trail content');
  return outcome;
}

function indexIn(order: readonly string[], id: string): number {
  const i = order.indexOf(id);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}
