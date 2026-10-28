// Trilha (TRL-01, spec 14; api §4.11): what trail-open, trail-prepare and trail-answer share. Loads the subject's
// outline, builds the path (trail.plan, repaired by normalizeTrailPlan), generates step content on demand
// (trail.lesson / trail.remediate / trail.checkpoint) and turns the stored steps into the state the app shows.
// Decisions about what comes next are the pure engine's (@studify/shared learning/trail.ts).
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ApiFailure,
  checkpointBlueprint,
  checkpointScore,
  chapterFraction,
  conceptStates,
  nextTrailMove,
  normalizeTrailPlan,
  trailNeeds,
  trailOutlineHash,
  trailProgress,
  type ProposedChapter,
  type SourcePage,
  type TrailChapter,
  type TrailNeed,
  type TrailOutlineTopic,
  type TrailPrerequisite,
  type TrailState,
  type TrailStep,
  type TrailStepPurpose,
  type TrailStepView,
} from '@studify/shared';
import { getTask, type DocumentMap } from '@studify/prompts';
import type { SubjectRow } from './access.ts';
import { callTask, unwrapResult } from './ai.ts';
import { budgetCtxFor } from './ctx.ts';
import { claudeDepsFor, type Deps } from './deps.ts';
import { loadTopic, topicSlices, type TopicBundle } from './topic.ts';
import { mapPages } from '../shared-p3/teaching.ts';

const FEATURE = 'TRL-01';
/** How long one trail-prepare may hold the generation lease. */
const LEASE_MS = 150_000;

// ---------------------------------------------------------------- rows

export interface TrailRow {
  id: string;
  user_id: string;
  subject_id: string;
  status: 'active' | 'completed';
  goal: string | null;
  plan: TrailChapter[];
  outline_hash: string;
  chapter_index: number;
  prompt_version: string | null;
  preparing_until: string | null;
  completed_at: string | null;
}

export interface QuestionContent {
  stem: string;
  options: Array<{ id: string; text: string; rationale: string }>;
  correct: string;
  explanation: string;
  tip: string | null;
  terms: Array<{ term: string; definition: string }>;
}

export interface LessonContent {
  title: string;
  body: string;
  terms: Array<{ term: string; definition: string }>;
}

export interface StepRow {
  id: string;
  trail_id: string;
  user_id: string;
  chapter_index: number;
  topic_id: string;
  concept_id: string;
  purpose: TrailStepPurpose;
  round: number;
  for_step_id: string | null;
  created_seq: number;
  served_seq: number | null;
  status: 'ready' | 'done' | 'discarded';
  content: LessonContent | QuestionContent;
  source_pages: SourcePage[];
  response: string | null;
  correct: boolean | null;
  answered_at: string | null;
}

export const isQuestionPurpose = (p: TrailStepPurpose) => p === 'practice' || p === 'remedial_question' || p === 'checkpoint';

export function toView(row: StepRow): TrailStepView {
  return {
    id: row.id,
    conceptId: row.concept_id,
    purpose: row.purpose,
    round: row.round,
    status: row.status,
    correct: row.correct ?? null,
    forStepId: row.for_step_id ?? null,
    createdSeq: row.created_seq,
    servedSeq: row.served_seq ?? null,
  };
}

// ---------------------------------------------------------------- outline

interface NodeRow {
  id: string;
  parent_id: string | null;
  kind: 'unit' | 'topic' | 'concept';
  title: string;
  summary: string | null;
  position: number;
  learning_objectives: string[] | null;
  key_terms: string[] | null;
  is_placeholder: boolean | null;
}

export interface Outline {
  topics: TrailOutlineTopic[];
  prerequisites: TrailPrerequisite[];
  nodes: Map<string, NodeRow>;
}

/**
 * The topics a path can teach (spec 14 §8.1): not excluded by the student ("não cai na prova"), not a
 * placeholder from a content list, and with pages of material to teach from. Concepts follow their topic.
 */
export async function loadOutline(db: SupabaseClient, userId: string, subjectId: string): Promise<Outline> {
  const nodes = await db
    .from('knowledge_nodes')
    .select('id, parent_id, kind, title, summary, position, learning_objectives, key_terms, is_placeholder, hidden_reason')
    .eq('subject_id', subjectId)
    .is('deleted_at', null);
  if (nodes.error) throw nodes.error;
  const rows = ((nodes.data as Array<NodeRow & { hidden_reason?: string | null }>) ?? []).filter((n) => !n.hidden_reason);
  const byId = new Map(rows.map((n) => [n.id, n]));

  const ids = rows.map((n) => n.id);
  const settings = ids.length ? await db.from('node_user_settings').select('node_id, excluded').eq('user_id', userId).is('deleted_at', null).in('node_id', ids) : { data: [], error: null };
  if (settings.error) throw settings.error;
  const excluded = new Set(((settings.data as Array<{ node_id: string; excluded: boolean }>) ?? []).filter((s) => s.excluded).map((s) => s.node_id));
  const isExcluded = (n: NodeRow): boolean => excluded.has(n.id) || (n.parent_id !== null && byId.has(n.parent_id) && isExcluded(byId.get(n.parent_id)!));

  const topicIds = rows.filter((n) => n.kind === 'topic').map((n) => n.id);
  const sources = topicIds.length ? await db.from('node_sources').select('node_id').in('node_id', topicIds).is('deleted_at', null) : { data: [], error: null };
  if (sources.error) throw sources.error;
  const withPages = new Set(((sources.data as Array<{ node_id: string }>) ?? []).map((s) => s.node_id));

  const rootPos = (n: NodeRow): number => {
    const parent = n.parent_id ? byId.get(n.parent_id) : undefined;
    return parent && parent.kind === 'unit' ? parent.position * 1000 + n.position : n.position * 1000;
  };
  const topics: TrailOutlineTopic[] = rows
    .filter((n) => n.kind === 'topic' && !n.is_placeholder && withPages.has(n.id) && !isExcluded(n))
    .map((n) => ({
      id: n.id,
      title: n.title,
      order: rootPos(n),
      concepts: rows.filter((c) => c.kind === 'concept' && c.parent_id === n.id && !isExcluded(c)).map((c) => ({ id: c.id, title: c.title, order: c.position })),
    }));

  const prereqs = ids.length ? await db.from('node_prerequisites').select('node_id, prerequisite_node_id').in('node_id', ids).is('deleted_at', null) : { data: [], error: null };
  if (prereqs.error) throw prereqs.error;
  const prerequisites = ((prereqs.data as Array<{ node_id: string; prerequisite_node_id: string }>) ?? []).map((p) => ({ nodeId: p.node_id, prerequisiteId: p.prerequisite_node_id }));
  return { topics, prerequisites, nodes: byId };
}

// ---------------------------------------------------------------- plan

/** Short keys for the model (T1…, C1…) and back. */
function keyMaps(topics: readonly TrailOutlineTopic[]) {
  const topicKey = new Map<string, string>();
  const conceptKey = new Map<string, string>();
  const fromKey = new Map<string, string>();
  let c = 0;
  topics.forEach((t, i) => {
    topicKey.set(t.id, `T${i + 1}`);
    fromKey.set(`T${i + 1}`, t.id);
    for (const concept of t.concepts) {
      c += 1;
      conceptKey.set(concept.id, `C${c}`);
      fromKey.set(`C${c}`, concept.id);
    }
  });
  return { topicKey, conceptKey, fromKey };
}

interface PlanOut {
  goal: string;
  chapters: Array<{ topic_key: string; why: string; concept_keys: string[] }>;
}

/**
 * The path for `topics` after the chapters already fixed (spec 14 §8.1). The model proposes the order; the
 * outline order is the fallback when the call fails, so the path never waits on AI to exist.
 */
export async function planChapters(
  deps: Deps,
  userId: string,
  subject: SubjectRow,
  outline: Outline,
  topics: readonly TrailOutlineTopic[],
  doneTitles: readonly string[],
): Promise<{ chapters: TrailChapter[]; goal: string | null; promptVersion: string | null }> {
  if (topics.length === 0) return { chapters: [], goal: null, promptVersion: null };
  const sorted = [...topics].sort((a, b) => a.order - b.order);
  const { topicKey, conceptKey, fromKey } = keyMaps(sorted);
  const keyOf = (id: string) => topicKey.get(id) ?? conceptKey.get(id);

  const units: Array<{ title: string | null; topics: Array<Record<string, unknown>> }> = [];
  for (const t of sorted) {
    const node = outline.nodes.get(t.id);
    const parent = node?.parent_id ? outline.nodes.get(node.parent_id) : undefined;
    const unitTitle = parent && parent.kind === 'unit' ? parent.title : null;
    if (units.at(-1)?.title !== unitTitle || units.length === 0) units.push({ title: unitTitle, topics: [] });
    units.at(-1)!.topics.push({
      key: topicKey.get(t.id),
      title: t.title,
      summary: node?.summary ?? null,
      objectives: node?.learning_objectives ?? [],
      concepts: [...t.concepts].sort((a, b) => a.order - b.order).map((c) => ({ key: conceptKey.get(c.id), title: c.title })),
    });
  }
  const needs = new Map<string, Set<string>>();
  for (const e of outline.prerequisites) {
    const a = keyOf(e.nodeId);
    const b = keyOf(e.prerequisiteId);
    if (a && b && a !== b) needs.set(a, (needs.get(a) ?? new Set()).add(b));
  }

  const task = getTask('trail.plan');
  try {
    const built = task.build({
      subjectName: subject.name,
      units,
      prerequisites: [...needs.entries()].map(([key, set]) => ({ key, needs: [...set].sort() })),
      alreadyDone: doneTitles,
      contentLanguage: subject.content_language ?? 'pt-BR',
      languageSubject: subject.is_language_subject,
    });
    const result = await callTask(claudeDepsFor(deps), {
      built,
      taskId: 'trail.plan',
      ctx: budgetCtxFor(subject, userId, FEATURE, 'user'),
      choices: { topic: [...topicKey.values()], concept: [...conceptKey.values()] },
    });
    const out = unwrapResult(result) as PlanOut;
    const proposed: ProposedChapter[] = out.chapters
      .map((ch) => ({ topicId: fromKey.get(ch.topic_key) ?? '', why: ch.why, conceptIds: ch.concept_keys.map((k) => fromKey.get(k) ?? '') }))
      .filter((ch) => ch.topicId);
    return { chapters: normalizeTrailPlan(proposed, sorted, outline.prerequisites), goal: out.goal, promptVersion: task.promptVersion };
  } catch (err) {
    // Budget, refusal or an unusable answer: the outline order still makes a valid path.
    console.warn('[trail] plan fallback', err instanceof Error ? err.message : err);
    return { chapters: normalizeTrailPlan([], sorted, outline.prerequisites), goal: null, promptVersion: null };
  }
}

/**
 * After the outline changed (new material, edits, "não cai na prova"): finished chapters and the one in progress
 * keep their place, with their concept lists refreshed; everything else is planned again.
 */
export async function replan(deps: Deps, userId: string, subject: SubjectRow, trail: TrailRow, outline: Outline, startedTopicIds: ReadonlySet<string>) {
  const live = new Map(outline.topics.map((t) => [t.id, t]));
  const fixedCount = Math.min(trail.plan.length, trail.chapter_index + (startedTopicIds.has(trail.plan[trail.chapter_index]?.topicId ?? '') ? 1 : 0));
  const fixed: TrailChapter[] = [];
  let doneCount = 0;
  trail.plan.slice(0, fixedCount).forEach((ch, i) => {
    const topic = live.get(ch.topicId);
    if (!topic) return;
    const own = [...topic.concepts].sort((a, b) => a.order - b.order).map((c) => c.id);
    const conceptIds = own.length ? [...ch.conceptIds.filter((id) => own.includes(id)), ...own.filter((id) => !ch.conceptIds.includes(id))] : [topic.id];
    fixed.push({ ...ch, conceptIds });
    if (i < trail.chapter_index) doneCount += 1;
  });
  const rest = outline.topics.filter((t) => !fixed.some((f) => f.topicId === t.id));
  const planned = await planChapters(deps, userId, subject, outline, rest, fixed.map((f) => live.get(f.topicId)!.title));
  return { plan: [...fixed, ...planned.chapters], chapterIndex: doneCount, goal: planned.goal ?? trail.goal, promptVersion: planned.promptVersion ?? trail.prompt_version };
}

export async function loadTrail(db: SupabaseClient, userId: string, trailId: string): Promise<TrailRow> {
  const row = await db.from('trails').select('*').eq('id', trailId).maybeSingle();
  if (row.error) throw row.error;
  if (!row.data || (row.data as TrailRow).user_id !== userId) throw new ApiFailure('not_found');
  return row.data as TrailRow;
}

export async function loadSteps(db: SupabaseClient, trailId: string): Promise<StepRow[]> {
  const rows = await db.from('trail_steps').select('*').eq('trail_id', trailId).order('created_seq');
  if (rows.error) throw rows.error;
  return (rows.data as StepRow[]) ?? [];
}

/** The outline hash also covers the topic set, so excluding or adding a topic re-plans the rest. */
export function outlineHashOf(outline: Outline): string {
  return trailOutlineHash(outline.topics);
}

// ---------------------------------------------------------------- generation

interface LessonOut {
  lesson: { title: string; body: string; terms: LessonContent['terms']; source_pages: Array<{ doc: string; page_start: number; page_end: number }> };
  questions: Array<Omit<QuestionContent, never> & { source_pages: Array<{ doc: string; page_start: number; page_end: number }> }>;
}
interface RemediationOut {
  lesson: LessonOut['lesson'];
  question: LessonOut['questions'][number];
}
interface CheckpointOut {
  questions: Array<LessonOut['questions'][number] & { concept_key: string }>;
}

function questionContent(q: LessonOut['questions'][number]): QuestionContent {
  return { stem: q.stem, options: q.options, correct: q.correct, explanation: q.explanation, tip: q.tip, terms: q.terms };
}

/** Titles of the concepts the path taught before `conceptId` (or up to it, `inclusive`), the last 12. */
function taughtBefore(trail: TrailRow, conceptId: string, outline: Outline, inclusive = false): string[] {
  const order = trail.plan.flatMap((ch) => ch.conceptIds);
  const idx = order.indexOf(conceptId);
  return order
    .slice(0, Math.max(0, idx + (inclusive ? 1 : 0)))
    .slice(-12)
    .map((id) => outline.nodes.get(id)?.title)
    .filter((t): t is string => !!t);
}

function conceptInput(bundle: TopicBundle, conceptId: string) {
  const concept = bundle.concepts.find((c) => c.id === conceptId);
  if (concept) return { key: concept.id, title: concept.title, summary: concept.summary, keyTerms: concept.key_terms ?? [] };
  // A topic without concepts is taught as one concept: itself.
  return { key: bundle.nodeId, title: bundle.title, summary: bundle.summary, keyTerms: bundle.keyTerms };
}

function topicPromptInput(bundle: TopicBundle) {
  return {
    title: bundle.title,
    summary: bundle.summary,
    objectives: bundle.objectives,
    concepts: bundle.concepts.map((c) => ({ key: c.id, title: c.title, keyTerms: c.key_terms ?? [], formulas: c.formulas ?? [] })),
  };
}

interface NewStep {
  concept_id: string;
  purpose: TrailStepPurpose;
  round: number;
  for_step_id: string | null;
  content: LessonContent | QuestionContent;
  source_pages: SourcePage[];
}

/**
 * Generates the content one need asks for and stores it as `ready` steps (spec 14 §7). The topic's PDF pages
 * are the cached prefix, so every step of a chapter reuses them.
 */
export async function generate(
  deps: Deps,
  userId: string,
  subject: SubjectRow,
  trail: TrailRow,
  chapterIndex: number,
  need: TrailNeed,
  steps: readonly StepRow[],
  outline: Outline,
): Promise<void> {
  const chapter = trail.plan[chapterIndex];
  if (!chapter) return;
  const bundle = await loadTopic(deps.db, userId, chapter.topicId);
  const { slices } = await topicSlices(deps, bundle);
  const base = {
    topic: topicPromptInput(bundle),
    slices,
    contentLanguage: bundle.contentLanguage,
    languageSubject: bundle.languageSubject,
  };
  const ctx = budgetCtxFor(subject, userId, FEATURE, 'user', { nodeId: chapter.topicId });
  const chapterSteps = steps.filter((s) => s.topic_id === chapter.topicId);
  const fresh: NewStep[] = [];
  let promptVersion: string;
  let documents: DocumentMap;

  if (need.kind === 'teach') {
    const task = getTask('trail.lesson');
    const built = task.build({ ...base, concept: conceptInput(bundle, need.conceptId), taughtBefore: taughtBefore(trail, need.conceptId, outline) });
    const out = unwrapResult(await callTask(claudeDepsFor(deps), { built, taskId: 'trail.lesson', ctx })) as LessonOut;
    documents = built.documents ?? { labels: {}, allowedPages: {} };
    promptVersion = task.promptVersion;
    fresh.push({ concept_id: need.conceptId, purpose: 'lesson', round: 0, for_step_id: null, content: { title: out.lesson.title, body: out.lesson.body, terms: out.lesson.terms }, source_pages: mapPages(out.lesson.source_pages, documents) });
    for (const q of out.questions) fresh.push({ concept_id: need.conceptId, purpose: 'practice', round: 0, for_step_id: null, content: questionContent(q), source_pages: mapPages(q.source_pages, documents) });
  } else if (need.kind === 'remediate') {
    const wrong = steps.find((s) => s.id === need.forStepId);
    if (!wrong) return;
    const q = wrong.content as QuestionContent;
    const chosen = q.options.find((o) => o.id === wrong.response);
    const right = q.options.find((o) => o.id === q.correct);
    const task = getTask('trail.remediate');
    const built = task.build({
      ...base,
      concept: conceptInput(bundle, need.conceptId),
      taughtBefore: taughtBefore(trail, need.conceptId, outline),
      mistake: { stem: q.stem, chosen: chosen?.text ?? '(sem resposta)', correct: right?.text ?? q.correct, explanation: q.explanation, inChapterTest: wrong.purpose === 'checkpoint' },
      askedStems: chapterSteps.filter((s) => s.concept_id === need.conceptId && isQuestionPurpose(s.purpose)).map((s) => (s.content as QuestionContent).stem).slice(-8),
    });
    const out = unwrapResult(await callTask(claudeDepsFor(deps), { built, taskId: 'trail.remediate', ctx })) as RemediationOut;
    documents = built.documents ?? { labels: {}, allowedPages: {} };
    promptVersion = task.promptVersion;
    fresh.push({ concept_id: need.conceptId, purpose: 'remedial_lesson', round: need.round, for_step_id: wrong.id, content: { title: out.lesson.title, body: out.lesson.body, terms: out.lesson.terms }, source_pages: mapPages(out.lesson.source_pages, documents) });
    fresh.push({ concept_id: need.conceptId, purpose: 'remedial_question', round: need.round, for_step_id: wrong.id, content: questionContent(out.question), source_pages: mapPages(out.question.source_pages, documents) });
  } else {
    const blueprint = checkpointBlueprint(chapter, chapterSteps.map(toView));
    const keys = new Map(blueprint.map((b, i) => [`C${i + 1}`, b.conceptId]));
    const keyOf = new Map([...keys.entries()].map(([k, id]) => [id, k]));
    const weak = new Set(chapterSteps.filter((s) => s.correct === false).map((s) => s.concept_id));
    const task = getTask('trail.checkpoint');
    const built = task.build({
      ...base,
      taughtBefore: taughtBefore(trail, chapter.conceptIds.at(-1)!, outline, true),
      blueprint: blueprint.map((b) => ({ key: keyOf.get(b.conceptId)!, title: outline.nodes.get(b.conceptId)?.title ?? bundle.title, count: b.count, weak: weak.has(b.conceptId) })),
      askedStems: chapterSteps.filter((s) => isQuestionPurpose(s.purpose)).map((s) => (s.content as QuestionContent).stem).slice(-20),
      round: need.round,
    });
    const out = unwrapResult(await callTask(claudeDepsFor(deps), { built, taskId: 'trail.checkpoint', ctx, choices: { concept: [...keys.keys()] } })) as CheckpointOut;
    documents = built.documents ?? { labels: {}, allowedPages: {} };
    promptVersion = task.promptVersion;
    const fallbackConcept = blueprint[0]?.conceptId ?? chapter.conceptIds[0]!;
    for (const q of out.questions) {
      fresh.push({ concept_id: keys.get(q.concept_key) ?? fallbackConcept, purpose: 'checkpoint', round: need.round, for_step_id: null, content: questionContent(q), source_pages: mapPages(q.source_pages, documents) });
    }
  }

  // Creation order continues after the newest step (re-read: another request may have added steps meanwhile).
  const last = await deps.db.from('trail_steps').select('created_seq').eq('trail_id', trail.id).order('created_seq', { ascending: false }).limit(1);
  if (last.error) throw last.error;
  let seq = ((last.data as Array<{ created_seq: number }>)[0]?.created_seq ?? 0) + 1;
  const rows = fresh.map((s) => ({
    id: deps.newId(),
    trail_id: trail.id,
    user_id: userId,
    chapter_index: chapterIndex,
    topic_id: chapter.topicId,
    status: 'ready',
    prompt_version: promptVersion,
    created_seq: seq++,
    served_seq: null,
    response: null,
    correct: null,
    answered_at: null,
    ...s,
  }));
  const inserted = await deps.db.from('trail_steps').insert(rows);
  if (inserted.error) throw inserted.error;
}

/** Takes the generation lease; false when another request is generating right now. */
export async function takeLease(db: SupabaseClient, trailId: string, now: Date): Promise<boolean> {
  const taken = await db
    .from('trails')
    .update({ preparing_until: new Date(now.getTime() + LEASE_MS).toISOString() })
    .eq('id', trailId)
    .or(`preparing_until.is.null,preparing_until.lt.${now.toISOString()}`)
    .select('id');
  if (taken.error) throw taken.error;
  return ((taken.data as unknown[]) ?? []).length > 0;
}

export async function releaseLease(db: SupabaseClient, trailId: string): Promise<void> {
  const released = await db.from('trails').update({ preparing_until: null }).eq('id', trailId);
  if (released.error) throw released.error;
}

/** What the current chapter (and the next one, for lookahead) still needs, blocking first. */
export function needsOf(trail: TrailRow, steps: readonly StepRow[]) {
  const chapter = trail.plan[trail.chapter_index];
  if (!chapter || trail.status === 'completed') return [];
  const next = trail.plan[trail.chapter_index + 1];
  return trailNeeds(
    chapter,
    steps.filter((s) => s.topic_id === chapter.topicId).map(toView),
    next ? { chapter: next, steps: steps.filter((s) => s.topic_id === next.topicId).map(toView) } : null,
  ).map((n) => ({ ...n, chapterIndex: n.nextChapter ? trail.chapter_index + 1 : trail.chapter_index }));
}

// ---------------------------------------------------------------- state

function publicStep(row: StepRow, outline: Outline, position: { index: number; total: number } | null): TrailStep {
  const base = {
    id: row.id,
    purpose: row.purpose,
    concept_id: row.concept_id,
    concept_title: outline.nodes.get(row.concept_id)?.title ?? '',
    terms: row.content.terms ?? [],
    source_pages: row.source_pages ?? [],
  };
  if (!isQuestionPurpose(row.purpose)) {
    const c = row.content as LessonContent;
    return { ...base, kind: 'lesson', title: c.title, body: c.body };
  }
  const q = row.content as QuestionContent;
  return { ...base, kind: 'question', stem: q.stem, options: q.options.map((o) => ({ id: o.id, text: o.text })), position };
}

/**
 * The state the app shows (TrailState). When the next move is a step not yet shown, it is marked as served here,
 * so leaving and coming back resumes on the same step.
 */
export async function buildState(deps: Deps, trail: TrailRow, steps: StepRow[], outline: Outline): Promise<TrailState> {
  const chapter = trail.plan[trail.chapter_index];
  const chapterSteps = chapter ? steps.filter((s) => s.topic_id === chapter.topicId) : [];
  const views = chapterSteps.map(toView);

  let step: TrailStep | null = null;
  let preparing = false;
  let phase: TrailState['phase'] = trail.status === 'completed' || !chapter ? 'completed' : 'learning';
  let checkpoint: TrailState['checkpoint'] = null;

  if (chapter && trail.status !== 'completed') {
    const round = Math.max(0, ...views.filter((s) => s.purpose === 'checkpoint').map((s) => s.round));
    if (round > 0) {
      phase = 'checkpoint';
      const qs = chapterSteps.filter((s) => s.purpose === 'checkpoint' && s.round === round && s.status !== 'discarded');
      checkpoint = { round, answered: qs.filter((s) => s.status === 'done').length, total: qs.length, correct: qs.filter((s) => s.correct).length };
    }
    const move = nextTrailMove(chapter, views);
    if (move.kind === 'serve') {
      const row = chapterSteps.find((s) => s.id === move.stepId)!;
      if (row.served_seq == null) {
        const served = Math.max(0, ...steps.map((s) => s.served_seq ?? 0)) + 1;
        const upd = await deps.db.from('trail_steps').update({ served_seq: served }).eq('id', row.id).is('served_seq', null);
        if (upd.error) throw upd.error;
        row.served_seq = served;
      }
      let position: { index: number; total: number } | null = null;
      if (row.purpose === 'checkpoint') {
        const qs = chapterSteps.filter((s) => s.purpose === 'checkpoint' && s.round === row.round && s.status !== 'discarded').sort((a, b) => a.created_seq - b.created_seq);
        position = { index: qs.findIndex((s) => s.id === row.id) + 1, total: qs.length };
      }
      step = publicStep(row, outline, position);
    } else if (move.kind === 'need') {
      preparing = true;
      if (move.need.kind === 'checkpoint') phase = 'checkpoint';
    }
  }

  const title = (id: string) => outline.nodes.get(id)?.title ?? '';
  const chapters = trail.plan.map((ch, i) => {
    const status: 'done' | 'current' | 'upcoming' = i < trail.chapter_index || trail.status === 'completed' ? 'done' : i === trail.chapter_index ? 'current' : 'upcoming';
    const states = status === 'current' ? conceptStates(ch, views) : ch.conceptIds.map((conceptId) => ({ conceptId, state: status === 'done' ? ('cleared' as const) : ('upcoming' as const) }));
    return { topic_id: ch.topicId, title: title(ch.topicId), why: ch.why, status, concepts: states.map((s) => ({ id: s.conceptId, title: title(s.conceptId), state: s.state })) };
  });
  const fraction = chapter ? chapterFraction(chapter, views) : 1;
  return {
    trail_id: trail.id,
    subject_id: trail.subject_id,
    status: trail.status,
    goal: trail.goal,
    progress: trail.status === 'completed' ? 1 : trailProgress(trail.plan.length, trail.chapter_index, fraction),
    chapter_index: trail.chapter_index,
    chapters,
    phase,
    checkpoint,
    step,
    preparing,
    prefetch: !preparing && needsOf(trail, steps).some((n) => !n.blocking),
  };
}

/** After an answer: closes the chapter when its test was passed (spec 14 §8.2) and moves the path forward. */
export async function advanceIfPassed(deps: Deps, trail: TrailRow, steps: StepRow[], now: Date): Promise<{ passed: boolean; trail: TrailRow }> {
  const chapter = trail.plan[trail.chapter_index];
  if (!chapter) return { passed: false, trail };
  const chapterSteps = steps.filter((s) => s.topic_id === chapter.topicId);
  if (nextTrailMove(chapter, chapterSteps.map(toView)).kind !== 'chapter_passed') return { passed: false, trail };
  // Spare questions of the finished chapter are not needed any more.
  const discarded = await deps.db.from('trail_steps').update({ status: 'discarded' }).eq('trail_id', trail.id).eq('topic_id', chapter.topicId).eq('status', 'ready').is('served_seq', null);
  if (discarded.error) throw discarded.error;
  for (const s of chapterSteps) if (s.status === 'ready' && s.served_seq == null) s.status = 'discarded';
  const chapterIndex = trail.chapter_index + 1;
  const completed = chapterIndex >= trail.plan.length;
  const patch = { chapter_index: chapterIndex, status: completed ? 'completed' : 'active', completed_at: completed ? now.toISOString() : null };
  const upd = await deps.db.from('trails').update(patch).eq('id', trail.id);
  if (upd.error) throw upd.error;
  return { passed: true, trail: { ...trail, ...patch } as TrailRow };
}

export { checkpointScore };
