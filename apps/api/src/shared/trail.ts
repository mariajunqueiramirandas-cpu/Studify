// Trilha (TRL-01, spec 14; api §4.11): what trail-open, trail-prepare and trail-answer share. Loads the subject's
// outline and its path, loads and leases trails and turns the stored steps into the state the app shows. Steps come
// from the content written ahead for the whole subject (trail_concept_content, ADR 0011) as soon as the path needs
// them, with no model call; only what that content does not cover is written by a Claude call, in trail-generate.ts.
// Decisions about what comes next are the pure engine's (@studify/shared learning/trail.ts).
import type { Db } from '@studify/db';
import {
  ApiFailure,
  McqSinglePayloadSchema,
  TRAIL,
  checkpointBlueprint,
  checkpointScore,
  chapterFraction,
  conceptStates,
  evidenceWeight,
  nextTrailMove,
  normalizeTrailPlan,
  trailNeeds,
  trailOutlineHash,
  trailProgress,
  trailTopicsOf,
  type ProposedChapter,
  type SourcePage,
  type TrailChapter,
  type TrailFeedback,
  type TrailNeed,
  type TrailOutlineTopic,
  type TrailPrerequisite,
  type TrailState,
  type TrailStep,
  type TrailStepAnswer,
  type TrailStepPurpose,
  type TrailStepView,
} from '@studify/shared';
import { inBackground, type Deps } from './deps.ts';
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
  /** The outline hash of the subject's map before this student's exclusions: what the subject's path is planned from. */
  subjectHash: string;
}

/**
 * The topics a path can teach (spec 14 §8.1, trailTopicsOf): not excluded by the student ("não cai na prova"), not a
 * placeholder from a content list, and with pages of material to teach from. Concepts follow their topic.
 */
export async function loadOutline(db: Db, userId: string, subjectId: string): Promise<Outline> {
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
  if (sources.error) throw sources.error;
  const withPages = new Set(((sources.data as Array<{ node_id: string }>) ?? []).map((s) => s.node_id));
  const topics = trailTopicsOf(rows, withPages, excluded);
  const subjectHash = trailOutlineHash(excluded.size > 0 ? trailTopicsOf(rows, withPages) : topics);

  if (prereqs.error) throw prereqs.error;
  const prerequisites = ((prereqs.data as Array<{ node_id: string; prerequisite_node_id: string }>) ?? []).map((p) => ({ nodeId: p.node_id, prerequisiteId: p.prerequisite_node_id }));
  return { topics, prerequisites, nodes: byId, subjectHash };
}

// ---------------------------------------------------------------- the subject's path

/** trail.plan for the whole subject, written ahead (trail.plan_subject): the order every student's path starts from. */
export interface SubjectPlan {
  outline_hash: string;
  goal: string | null;
  chapters: ProposedChapter[];
  prompt_version: string;
}

export async function loadSubjectPlan(db: Db, subjectId: string): Promise<SubjectPlan | null> {
  const row = await db.from('trail_subject_plans').select('outline_hash, goal, chapters, prompt_version').eq('subject_id', subjectId).maybeSingle();
  if (row.error) throw row.error;
  return (row.data as SubjectPlan | null) ?? null;
}

/**
 * The chapters for `topics` (spec 14 §8.1) with no model call: the subject's path repaired against this student's
 * map (exclusions, topics added since it was planned), or the outline order when the subject has no path yet.
 */
export function planFrom(outline: Outline, topics: readonly TrailOutlineTopic[], subjectPlan: SubjectPlan | null): TrailChapter[] {
  return normalizeTrailPlan(subjectPlan?.chapters ?? [], topics, outline.prerequisites);
}

/**
 * After the outline changed (new material, edits, "não cai na prova"), or once the subject's path is ready for a trail
 * that started in outline order: finished chapters and the one in progress keep their place, with their concept lists
 * refreshed; everything else follows the subject's path.
 */
export function replan(trail: TrailRow, outline: Outline, startedTopicIds: ReadonlySet<string>, subjectPlan: SubjectPlan | null) {
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
  return {
    plan: [...fixed, ...planFrom(outline, rest, subjectPlan)],
    chapterIndex: doneCount,
    goal: subjectPlan?.goal ?? trail.goal,
    promptVersion: subjectPlan?.prompt_version ?? trail.prompt_version,
  };
}

// ---------------------------------------------------------------- plan

/** Short keys for the model (T1…, C1…) and back. */

export async function loadTrail(db: Db, userId: string, trailId: string): Promise<TrailRow> {
  const row = await db.from('trails').select('*').eq('id', trailId).maybeSingle();
  if (row.error) throw row.error;
  if (!row.data || (row.data as TrailRow).user_id !== userId) throw new ApiFailure('not_found');
  return row.data as TrailRow;
}

export async function loadSteps(db: Db, trailId: string): Promise<StepRow[]> {
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
export async function takeLease(db: Db, trailId: string, now: Date): Promise<boolean> {
  const taken = await db
    .from('trails')
    .update({ preparing_until: new Date(now.getTime() + LEASE_MS).toISOString() })
    .eq('id', trailId)
    .or(`preparing_until.is.null,preparing_until.lt.${now.toISOString()}`)
    .select('id');
  if (taken.error) throw taken.error;
  return ((taken.data as unknown[]) ?? []).length > 0;
}

export async function releaseLease(db: Db, trailId: string): Promise<void> {
  const released = await db.from('trails').update({ preparing_until: null }).eq('id', trailId);
  if (released.error) throw released.error;
}

// ---------------------------------------------------------------- content written ahead

export interface BankLesson extends LessonContent {
  source_pages: SourcePage[];
}

export interface BankQuestion extends QuestionContent {
  source_pages: SourcePage[];
}

/** One concept's shared content (trail_concept_content): written while the material was processed, or on demand. */
export interface BankRow {
  concept_id: string;
  topic_id: string;
  lesson: BankLesson;
  practice: BankQuestion[];
  remedial_lesson: BankLesson | null;
  remedial_questions: BankQuestion[];
  test_questions: BankQuestion[];
  prompt_version: string;
  reinforce_prompt_version: string | null;
}

export type Bank = Map<string, BankRow>;

export async function loadBank(db: Db, conceptIds: readonly string[]): Promise<Bank> {
  if (conceptIds.length === 0) return new Map();
  const rows = await db
    .from('trail_concept_content')
    .select('concept_id, topic_id, lesson, practice, remedial_lesson, remedial_questions, test_questions, prompt_version, reinforce_prompt_version')
    .in('concept_id', [...new Set(conceptIds)]);
  if (rows.error) throw rows.error;
  return new Map(((rows.data as BankRow[]) ?? []).map((r) => [r.concept_id, r]));
}

/** The concepts of the chapter the student is on and of the next one: what the next steps can come from. */
export function nearConceptIds(trail: TrailRow): string[] {
  return [trail.plan[trail.chapter_index], trail.plan[trail.chapter_index + 1]].flatMap((ch) => ch?.conceptIds ?? []);
}

/** A step to store: the content of one lesson or question and where it belongs. */
export interface NewStep {
  concept_id: string;
  purpose: TrailStepPurpose;
  round: number;
  for_step_id: string | null;
  content: LessonContent | QuestionContent;
  source_pages: SourcePage[];
  prompt_version: string;
}

const lessonStep = (s: Omit<NewStep, 'content' | 'source_pages'>, l: BankLesson): NewStep => ({ ...s, content: { title: l.title, body: l.body, terms: l.terms }, source_pages: l.source_pages });
const questionStep = (s: Omit<NewStep, 'content' | 'source_pages'>, q: BankQuestion): NewStep => ({
  ...s,
  content: { stem: q.stem, options: q.options, correct: q.correct, explanation: q.explanation, tip: q.tip, terms: q.terms },
  source_pages: q.source_pages,
});

/**
 * The steps a need gets from the content written ahead, or null when that content does not cover it (then a Claude
 * call writes it, trail-generate.ts). Questions already asked in the chapter are never asked again.
 *  - teach: the concept's lesson and its practice questions.
 *  - remediate: the re-explanation from another angle and a fresh question on the same point. While learning, the
 *    re-explanation is shown once per concept; a later miss gets the next fresh question alone (its feedback already
 *    explained the mistake). Before a new chapter-test round the concept is re-explained again.
 *  - checkpoint: the blueprint's count of test questions per concept (from a second round on, the unused fresh
 *    questions too), one concept after another so the test is mixed.
 */
export function bankStepsFor(need: TrailNeed, chapter: TrailChapter, chapterSteps: readonly StepRow[], bank: Bank): NewStep[] | null {
  const asked = new Set(chapterSteps.filter((s) => isQuestionPurpose(s.purpose)).map((s) => (s.content as QuestionContent).stem));
  if (need.kind === 'teach') {
    const row = bank.get(need.conceptId);
    if (!row) return null;
    const base = { concept_id: need.conceptId, round: 0, for_step_id: null, prompt_version: row.prompt_version };
    return [lessonStep({ ...base, purpose: 'lesson' }, row.lesson), ...row.practice.filter((q) => !asked.has(q.stem)).map((q) => questionStep({ ...base, purpose: 'practice' }, q))];
  }
  if (need.kind === 'remediate') {
    const row = bank.get(need.conceptId);
    if (!row?.remedial_lesson || !row.reinforce_prompt_version) return null;
    const question = row.remedial_questions.find((q) => !asked.has(q.stem));
    if (!question) return null;
    const base = { concept_id: need.conceptId, round: need.round, for_step_id: need.forStepId, prompt_version: row.reinforce_prompt_version };
    const shown = chapterSteps.some((s) => s.purpose === 'remedial_lesson' && s.concept_id === need.conceptId && (s.content as LessonContent).body === row.remedial_lesson!.body);
    return [...(!shown || need.round > 0 ? [lessonStep({ ...base, purpose: 'remedial_lesson' }, row.remedial_lesson)] : []), questionStep({ ...base, purpose: 'remedial_question' }, question)];
  }
  const picks: NewStep[][] = [];
  for (const { conceptId, count } of checkpointBlueprint(chapter, chapterSteps.map(toView))) {
    const row = bank.get(conceptId);
    if (!row?.reinforce_prompt_version) return null;
    const pool = [...row.test_questions, ...(need.round > 1 ? row.remedial_questions : [])].filter((q) => !asked.has(q.stem));
    if (pool.length < count) return null;
    const base = { concept_id: conceptId, purpose: 'checkpoint' as const, round: need.round, for_step_id: null, prompt_version: row.reinforce_prompt_version };
    picks.push(pool.slice(0, count).map((q) => questionStep(base, q)));
  }
  const mixed: NewStep[] = [];
  for (let i = 0; picks.some((p) => p[i]); i += 1) for (const p of picks) if (p[i]) mixed.push(p[i]!);
  return mixed;
}

/** Whether the content written ahead covers a need of the current or the next chapter. */
export function bankCovers(trail: TrailRow, steps: readonly StepRow[], need: ReturnType<typeof needsOf>[number], bank: Bank): boolean {
  const chapter = trail.plan[need.chapterIndex];
  return !!chapter && bankStepsFor(need.need, chapter, steps.filter((s) => s.topic_id === chapter.topicId), bank) !== null;
}

/** Rows for new steps of a chapter, in creation order after `afterSeq`. */
export function stepRows(deps: Deps, trail: TrailRow, chapterIndex: number, fresh: readonly NewStep[], afterSeq: number) {
  const topicId = trail.plan[chapterIndex]!.topicId;
  let seq = afterSeq + 1;
  return fresh.map((s) => ({
    id: deps.newId(),
    trail_id: trail.id,
    user_id: trail.user_id,
    chapter_index: chapterIndex,
    topic_id: topicId,
    status: 'ready' as const,
    created_seq: seq++,
    served_seq: null,
    response: null,
    correct: null,
    answered_at: null,
    question_id: null,
    ...s,
  }));
}

const lastSeq = (steps: readonly StepRow[]) => Math.max(0, ...steps.map((s) => s.created_seq));

/**
 * Copies the steps the chapter needs next from the content written ahead, until the next move is a step to show or a
 * need that content does not cover. Creation numbers follow the steps this request read, so two requests filling the
 * same need collide on (trail_id, created_seq): the second re-reads the steps and finds the need already filled.
 */
async function fillFromBank(deps: Deps, trail: TrailRow, steps: StepRow[], bank: Bank): Promise<StepRow[]> {
  const chapter = trail.plan[trail.chapter_index];
  if (!chapter || trail.status === 'completed') return steps;
  for (let round = 0; round < 6; round += 1) {
    const chapterSteps = steps.filter((s) => s.topic_id === chapter.topicId);
    const move = nextTrailMove(chapter, chapterSteps.map(toView));
    if (move.kind !== 'need') return steps;
    const fresh = bankStepsFor(move.need, chapter, chapterSteps, bank);
    if (!fresh || fresh.length === 0) return steps;
    const rows = stepRows(deps, trail, trail.chapter_index, fresh, lastSeq(steps)) as StepRow[];
    const inserted = await deps.db.from('trail_steps').insert(rows);
    if (inserted.error?.code === '23505') {
      steps = await loadSteps(deps.db, trail.id);
      continue;
    }
    if (inserted.error) throw inserted.error;
    steps = [...steps, ...rows];
  }
  return steps;
}

/**
 * Starts writing, in the background, the shared content the current and the next chapter still lack (a subject whose
 * material was processed before the Trilha was written ahead, or a concept whose call failed then): the student keeps
 * going on what exists, and the rest is ready by the time they reach it. Best effort.
 */
export async function prepareAhead(deps: Deps, trail: TrailRow, bank?: Bank): Promise<void> {
  const known = bank ?? (await loadBank(deps.db, nearConceptIds(trail)));
  const topics = [trail.plan[trail.chapter_index], trail.plan[trail.chapter_index + 1]].filter(
    (ch): ch is TrailChapter => !!ch && ch.conceptIds.some((id) => !known.get(id)?.reinforce_prompt_version),
  );
  await Promise.all(
    topics.map((ch) =>
      inBackground(deps, 'trail.prepare_topic', { topic_id: ch.topicId, user_id: trail.user_id }, ch.topicId).catch((err) => {
        console.warn('[trail] prepare ahead', err instanceof Error ? err.message : err);
        return null;
      }),
    ),
  );
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
  return { ...base, kind: 'question', stem: q.stem, options: q.options.map((o) => ({ id: o.id, text: o.text })), position, answer: answerOf(q) };
}

/** The answer a question carries to the app: the verdict and the explanation are shown at once, before the record. */
function answerOf(q: QuestionContent): TrailStepAnswer {
  return { correct_option: q.correct, explanation: q.explanation, tip: q.tip, rationales: q.options.map((o) => ({ id: o.id, text: o.text, rationale: o.rationale })) };
}

/** A chapter-test question's place in its round ("3 de 6"); other steps have none. */
function positionOf(row: StepRow, chapterSteps: StepRow[]): { index: number; total: number } | null {
  if (row.purpose !== 'checkpoint') return null;
  const qs = chapterSteps.filter((s) => s.purpose === 'checkpoint' && s.round === row.round && s.status !== 'discarded').sort((a, b) => a.created_seq - b.created_seq);
  return { index: qs.findIndex((s) => s.id === row.id) + 1, total: qs.length };
}

/**
 * The step that follows a lesson on screen, when it is already written. The app shows it as soon as the student
 * is done with the lesson and records the lesson behind it, so the next step does not wait on the server. It follows
 * the same rule trail-answer serves by, with the lesson marked read.
 */
function stepAfterLesson(chapter: TrailChapter, views: TrailStepView[], row: StepRow, chapterSteps: StepRow[], outline: Outline): TrailStep | null {
  if (isQuestionPurpose(row.purpose)) return null;
  const read = views.map((v) => (v.id === row.id ? { ...v, status: 'done' as const } : v));
  const move = nextTrailMove(chapter, read);
  if (move.kind !== 'serve') return null;
  const next = chapterSteps.find((s) => s.id === move.stepId)!;
  return publicStep(next, outline, positionOf(next, chapterSteps));
}

/** Ensine o Lucas on the topic (TRL-01.12): the best finished score and how many lessons were finished. */
export async function lucasResult(db: Db, userId: string, topicId: string): Promise<{ best: number | null; attempts: number }> {
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
async function bossFor(db: Db, trail: TrailRow, outline: Outline): Promise<TrailState['boss']> {
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
 * The state the app shows (TrailState). Steps the path needs next are copied from the content written ahead first
 * (fillFromBank), so the state is `preparing` only when that content does not cover them. When the next move is a
 * step not yet shown, it is marked as served here, so leaving and coming back resumes on the same step.
 */
export async function buildState(
  deps: Deps,
  trail: TrailRow,
  loaded: StepRow[],
  outline: Outline,
  extras: { chapterDone?: TrailState['chapter_done'] } = {},
): Promise<TrailState> {
  let steps = loaded;
  const wanted = needsOf(trail, steps);
  const bank = wanted.length > 0 ? await loadBank(deps.db, nearConceptIds(trail)) : new Map<string, BankRow>();
  if (wanted.some((n) => n.blocking)) steps = await fillFromBank(deps, trail, steps, bank);
  const chapter = trail.plan[trail.chapter_index];
  const chapterSteps = chapter ? steps.filter((s) => s.topic_id === chapter.topicId) : [];
  const views = chapterSteps.map(toView);

  let step: TrailStep | null = null;
  let nextStep: TrailStep | null = null;
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
      step = publicStep(row, outline, positionOf(row, chapterSteps));
      nextStep = stepAfterLesson(chapter, views, row, chapterSteps, outline);
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
    next_step: nextStep,
    teach,
    boss: await bossFor(deps.db, trail, outline),
    chapter_done: extras.chapterDone ?? null,
    preparing,
    // Only what the content written ahead does not cover is worth a trail-prepare in the background.
    prefetch: !preparing && needsOf(trail, steps).some((n) => !n.blocking && !bankCovers(trail, steps, n, bank)),
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

/** The explanation of an answered question, from the content stored when it was written. */
export function feedbackOf(row: StepRow): TrailFeedback {
  return { correct: row.correct === true, ...answerOf(row.content as QuestionContent) };
}

/**
 * What a graded question leaves behind: mastery evidence (learning-engine §5.2) and the recompute job, and for a
 * miss the Caderno entry when `caderno` is set. The writes do not depend on each other, so they run together; the
 * Caderno save is best effort, since the answer is already recorded.
 */
export async function recordQuestionAnswer(deps: Deps, trail: TrailRow, row: StepRow, timeSpentMs: number, now: Date, caderno: boolean): Promise<string | null> {
  const { db } = deps;
  const correct = row.correct === true;
  const answeredAt = row.answered_at ?? now.toISOString();
  const score = correct ? 1 : 0;
  const weight = evidenceWeight({ id: row.id, conceptId: row.concept_id, answeredAt: new Date(answeredAt), questionType: 'mcq_single', source: 'trail', score });
  const evidence = db.from('mastery_evidence').upsert(
    [{ user_id: trail.user_id, node_id: row.concept_id, subject_id: trail.subject_id, source: 'trail', outcome: score, weight, ref_type: 'trail_step', ref_id: row.id, occurred_at: answeredAt }],
    { onConflict: 'ref_type,ref_id,node_id', ignoreDuplicates: true },
  );
  const recompute = deps.execute('mastery.recompute', { user_id: trail.user_id, node_ids: [row.concept_id] }, { singletonKey: `mastery.recompute:${trail.user_id}`, startAfterSeconds: 60 });
  const mistake =
    caderno && !correct
      ? saveMistake(deps, trail, row, timeSpentMs, now).catch((err) => {
          console.warn('[trail] caderno', err instanceof Error ? err.message : err);
          return null;
        })
      : Promise.resolve(null);
  const [ev, , saved] = await Promise.all([evidence, recompute, mistake]);
  if (ev.error) throw ev.error;
  return saved;
}

export { checkpointScore };
