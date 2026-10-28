// Trilha (TRL-01, spec 14; api §4.11): what trail-open, trail-prepare and trail-answer share. Loads the subject's
// outline, loads and leases trails and turns the stored steps into the state the app shows. The Claude calls (the
// trail.plan path and the trail.lesson / trail.remediate / trail.checkpoint content) live in trail-generate.ts.
// Decisions about what comes next are the pure engine's (@studify/shared learning/trail.ts).
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ApiFailure,
  McqSinglePayloadSchema,
  TRAIL,
  checkpointScore,
  chapterFraction,
  conceptStates,
  nextTrailMove,
  trailNeeds,
  trailOutlineHash,
  trailProgress,
  type SourcePage,
  type TrailChapter,
  type TrailOutlineTopic,
  type TrailPrerequisite,
  type TrailState,
  type TrailStep,
  type TrailStepPurpose,
  type TrailStepView,
} from '@studify/shared';
import type { Deps } from './deps.ts';
import { recordMistake } from './mistakes.ts';

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
  quiz_attempt_id?: string | null;
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
  question_id?: string | null;
  prompt_version: string;
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
  const topicIds = rows.filter((n) => n.kind === 'topic').map((n) => n.id);
  // The three lookups only need the node ids, so they run together: one round trip instead of three.
  const [settings, sources, prereqs] = await Promise.all([
    ids.length ? db.from('node_user_settings').select('node_id, excluded').eq('user_id', userId).is('deleted_at', null).in('node_id', ids) : { data: [], error: null },
    topicIds.length ? db.from('node_sources').select('node_id').in('node_id', topicIds).is('deleted_at', null) : { data: [], error: null },
    ids.length ? db.from('node_prerequisites').select('node_id, prerequisite_node_id').in('node_id', ids).is('deleted_at', null) : { data: [], error: null },
  ]);
  if (settings.error) throw settings.error;
  const excluded = new Set(((settings.data as Array<{ node_id: string; excluded: boolean }>) ?? []).filter((s) => s.excluded).map((s) => s.node_id));
  const isExcluded = (n: NodeRow): boolean => excluded.has(n.id) || (n.parent_id !== null && byId.has(n.parent_id) && isExcluded(byId.get(n.parent_id)!));

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

  if (prereqs.error) throw prereqs.error;
  const prerequisites = ((prereqs.data as Array<{ node_id: string; prerequisite_node_id: string }>) ?? []).map((p) => ({ nodeId: p.node_id, prerequisiteId: p.prerequisite_node_id }));
  return { topics, prerequisites, nodes: byId };
}

// ---------------------------------------------------------------- plan

/** Short keys for the model (T1…, C1…) and back. */

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

/** Ensine o Lucas on the topic (TRL-01.12): the best finished score and how many lessons were finished. */
export async function lucasResult(db: SupabaseClient, userId: string, topicId: string): Promise<{ best: number | null; attempts: number }> {
  const rows = await db.from('teaching_sessions').select('score').eq('user_id', userId).eq('node_id', topicId).eq('status', 'finished').is('deleted_at', null);
  if (rows.error) throw rows.error;
  const list = (rows.data as Array<{ score: number | null }>) ?? [];
  const scores = list.map((r) => r.score).filter((x): x is number => typeof x === 'number');
  return { best: scores.length ? Math.max(...scores) : null, attempts: list.length };
}

function unitOf(outline: Outline, topicId: string): NodeRow | null {
  const parentId = outline.nodes.get(topicId)?.parent_id;
  const parent = parentId ? outline.nodes.get(parentId) : undefined;
  return parent && parent.kind === 'unit' ? parent : null;
}

/**
 * The Chefão to offer (TRL-01.14): the latest unit of the path whose chapters (at least 2) are all done and whose
 * boss the student has not defeated yet.
 */
async function bossFor(db: SupabaseClient, trail: TrailRow, outline: Outline): Promise<TrailState['boss']> {
  const doneCount = trail.status === 'completed' ? trail.plan.length : trail.chapter_index;
  const done = new Set(trail.plan.slice(0, doneCount).map((c) => c.topicId));
  const byUnit = new Map<string, { topics: string[]; lastIndex: number }>();
  trail.plan.forEach((ch, i) => {
    const unit = unitOf(outline, ch.topicId);
    if (!unit) return;
    const entry = byUnit.get(unit.id) ?? { topics: [], lastIndex: -1 };
    entry.topics.push(ch.topicId);
    entry.lastIndex = i;
    byUnit.set(unit.id, entry);
  });
  const ready = [...byUnit.entries()].filter(([, u]) => u.topics.length >= 2 && u.topics.every((t) => done.has(t))).sort((a, b) => b[1].lastIndex - a[1].lastIndex);
  if (ready.length === 0) return null;
  const beaten = await db.from('boss_attempts').select('unit_node_id').eq('user_id', trail.user_id).eq('passed', true).in('unit_node_id', ready.map(([id]) => id));
  if (beaten.error) throw beaten.error;
  const defeated = new Set(((beaten.data as Array<{ unit_node_id: string }>) ?? []).map((b) => b.unit_node_id));
  const open = ready.find(([id]) => !defeated.has(id));
  return open ? { unit_id: open[0], title: outline.nodes.get(open[0])?.title ?? '' } : null;
}

/**
 * The state the app shows (TrailState). When the next move is a step not yet shown, it is marked as served here,
 * so leaving and coming back resumes on the same step.
 */
export async function buildState(
  deps: Deps,
  trail: TrailRow,
  steps: StepRow[],
  outline: Outline,
  extras: { chapterDone?: TrailState['chapter_done'] } = {},
): Promise<TrailState> {
  const chapter = trail.plan[trail.chapter_index];
  const chapterSteps = chapter ? steps.filter((s) => s.topic_id === chapter.topicId) : [];
  const views = chapterSteps.map(toView);

  let step: TrailStep | null = null;
  let preparing = false;
  let phase: TrailState['phase'] = trail.status === 'completed' || !chapter ? 'completed' : 'learning';
  let checkpoint: TrailState['checkpoint'] = null;
  let teach: TrailState['teach'] = null;

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
    } else {
      // Test passed: the chapter closes once the student teaches Lucas the topic (TRL-01.12).
      phase = 'teach';
      const lucas = await lucasResult(deps.db, trail.user_id, chapter.topicId);
      teach = { topic_id: chapter.topicId, title: outline.nodes.get(chapter.topicId)?.title ?? '', pass_score: TRAIL.teachPassScore, best_score: lucas.best, attempts: lucas.attempts };
    }
  }

  const title = (id: string) => outline.nodes.get(id)?.title ?? '';
  const chapters = trail.plan.map((ch, i) => {
    const status: 'done' | 'current' | 'upcoming' = i < trail.chapter_index || trail.status === 'completed' ? 'done' : i === trail.chapter_index ? 'current' : 'upcoming';
    const states = status === 'current' ? conceptStates(ch, views) : ch.conceptIds.map((conceptId) => ({ conceptId, state: status === 'done' ? ('cleared' as const) : ('upcoming' as const) }));
    return { topic_id: ch.topicId, unit_id: unitOf(outline, ch.topicId)?.id ?? null, title: title(ch.topicId), why: ch.why, status, concepts: states.map((s) => ({ id: s.conceptId, title: title(s.conceptId), state: s.state })) };
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
    teach,
    boss: await bossFor(deps.db, trail, outline),
    chapter_done: extras.chapterDone ?? null,
    preparing,
    prefetch: !preparing && needsOf(trail, steps).some((n) => !n.blocking),
  };
}

/**
 * Closes the chapter when its test was passed and Lucas was taught the topic (spec 14 §8.2), and moves the path
 * forward. Returns what finished, for the "capítulo concluído" screen.
 */
export async function advanceIfPassed(
  deps: Deps,
  trail: TrailRow,
  steps: StepRow[],
  outline: Outline,
  now: Date,
): Promise<{ trail: TrailRow; chapterDone: TrailState['chapter_done'] }> {
  const chapter = trail.plan[trail.chapter_index];
  if (!chapter || trail.status === 'completed') return { trail, chapterDone: null };
  const chapterSteps = steps.filter((s) => s.topic_id === chapter.topicId);
  if (nextTrailMove(chapter, chapterSteps.map(toView)).kind !== 'chapter_passed') return { trail, chapterDone: null };
  const lucas = await lucasResult(deps.db, trail.user_id, chapter.topicId);
  if ((lucas.best ?? -1) < TRAIL.teachPassScore) return { trail, chapterDone: null };
  // Spare questions of the finished chapter are not needed any more.
  const discarded = await deps.db.from('trail_steps').update({ status: 'discarded' }).eq('trail_id', trail.id).eq('topic_id', chapter.topicId).eq('status', 'ready').is('served_seq', null);
  if (discarded.error) throw discarded.error;
  for (const s of chapterSteps) if (s.status === 'ready' && s.served_seq == null) s.status = 'discarded';
  const chapterIndex = trail.chapter_index + 1;
  const completed = chapterIndex >= trail.plan.length;
  const patch = { chapter_index: chapterIndex, status: completed ? 'completed' : 'active', completed_at: completed ? now.toISOString() : null };
  const upd = await deps.db.from('trails').update(patch).eq('id', trail.id);
  if (upd.error) throw upd.error;
  const next = trail.plan[chapterIndex];
  return {
    trail: { ...trail, ...patch } as TrailRow,
    chapterDone: { topic_id: chapter.topicId, title: outline.nodes.get(chapter.topicId)?.title ?? '', next_title: next ? (outline.nodes.get(next.topicId)?.title ?? null) : null },
  };
}

/**
 * The Caderno de Erros (TRL-01.13): a missed Trilha question becomes a personal bank question answered in the
 * trail's implicit attempt, then a mistakes row with its remediation card, so the Caderno schedules its retries.
 */
export async function saveMistake(deps: Deps, trail: TrailRow, row: StepRow, timeSpentMs: number, now: Date): Promise<string | null> {
  const { db } = deps;
  const q = row.content as QuestionContent;
  const payload = { options: q.options.map((o) => ({ id: o.id, text: o.text, rationale: o.rationale })), correct: q.correct };
  // Bank questions follow the PRA-01 rules (4–5 options, no "todas as anteriores"); others stay out of the Caderno.
  if (!McqSinglePayloadSchema.safeParse(payload).success) return null;

  let attemptId = trail.quiz_attempt_id;
  if (!attemptId) {
    const quizId = deps.newId();
    attemptId = deps.newId();
    const quiz = await db.from('quizzes').insert({ id: quizId, owner_id: trail.user_id, subject_id: trail.subject_id, kind: 'trail', mode: 'practice', title: 'Trilha', question_ids: [] });
    if (quiz.error) throw quiz.error;
    const attempt = await db.from('quiz_attempts').insert({ id: attemptId, user_id: trail.user_id, quiz_id: quizId, status: 'submitted', started_at: now.toISOString(), finished_at: now.toISOString(), device_id: 'trail' });
    if (attempt.error) throw attempt.error;
    const linked = await db.from('trails').update({ quiz_attempt_id: attemptId }).eq('id', trail.id);
    if (linked.error) throw linked.error;
    trail.quiz_attempt_id = attemptId;
  }

  const questionId = deps.newId();
  const conceptIds = row.concept_id !== row.topic_id ? [row.concept_id] : [];
  const question = {
    id: questionId,
    subject_id: trail.subject_id,
    node_id: row.topic_id,
    concept_ids: conceptIds,
    type: 'mcq_single' as const,
    stem: q.stem,
    payload,
    explanation: q.explanation,
    has_math: /\$/.test(q.stem + q.options.map((o) => o.text).join(' ')),
    source_pages: row.source_pages ?? [],
    origin: 'generated',
    personal_for_user_id: trail.user_id,
    prompt_version: row.prompt_version,
  };
  const inserted = await db.from('questions').insert(question);
  if (inserted.error) throw inserted.error;

  const answerId = deps.newId();
  const response = { choice: row.response };
  // The answer and the link back to the step both only need the question: write them together.
  const [answer, linked] = await Promise.all([
    db.from('attempt_answers').insert({
      id: answerId,
      attempt_id: attemptId,
      user_id: trail.user_id,
      question_id: questionId,
      question_version: 1,
      response,
      correct: false,
      score: 0,
      grading_status: 'graded',
      time_spent_ms: timeSpentMs,
      answered_at: row.answered_at ?? now.toISOString(),
    }),
    db.from('trail_steps').update({ question_id: questionId }).eq('id', row.id),
  ]);
  if (answer.error) throw answer.error;
  if (linked.error) throw linked.error;

  const outcome = await recordMistake(db, deps.newId, {
    userId: trail.user_id,
    answerId,
    question: { id: questionId, node_id: row.topic_id, subject_id: trail.subject_id, type: 'mcq_single', stem: q.stem, payload, explanation: q.explanation, concept_ids: conceptIds, source_pages: row.source_pages ?? [] },
    score: 0,
    confidence: null,
    response,
    timeSeconds: Math.round(timeSpentMs / 1000),
    now,
  });
  return outcome.mistakeId;
}

export { checkpointScore };
