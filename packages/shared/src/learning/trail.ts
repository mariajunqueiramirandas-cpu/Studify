// Trilha (TRL-01, spec 14): the guided path of a subject. Pure functions: the server loads the outline and
// the trail's steps, calls these, and persists what they decide. The AI proposes the order (trail.plan) and
// writes the content (lessons and questions); everything here is the deterministic part: repairing the order
// against prerequisites, picking the next step, deciding what content to prepare ahead, and progress.
import type { TrailStepPurposeName, TrailStepStatusName } from '../core/enums.ts';
import { compareStrings } from './util.ts';

export const TRAIL = {
  /** Correct answers that clear a concept (spec 14 §8.2). */
  clearCorrect: 2,
  /** After this many answers on one concept it is "shaky" and the path moves on; the chapter test still gates. */
  maxConceptQuestions: 5,
  /** Questions written with each lesson: two are asked, one is a spare. */
  practicePerLesson: 3,
  checkpointPerConcept: 2,
  checkpointMin: 4,
  checkpointMax: 10,
  /** Same bar as a Chefão (MOT-02.4). */
  checkpointPass: 0.7,
  /** Concepts re-taught after a failed chapter test, weakest first. */
  remediationsAfterCheckpoint: 3,
  /** Lessons written ahead of the student, within the chapter (spec 14 §8.3). */
  lookahead: 2,
  /** Ensine o Lucas closes every chapter: a finished lesson on the topic at the "good" band or above (spec 12 §5.2). */
  teachPassScore: 70,
} as const;

// ---------------------------------------------------------------- plan

export interface TrailOutlineTopic {
  id: string;
  title: string;
  /** Outline order: unit position first, then topic position (callers flatten the tree). */
  order: number;
  concepts: ReadonlyArray<{ id: string; title: string; order: number }>;
}

export interface TrailPrerequisite {
  nodeId: string;
  prerequisiteId: string;
}

export interface TrailChapter {
  topicId: string;
  /** "Por que agora": the model's reason for this place in the path, or null for the outline fallback. */
  why: string | null;
  /** Teaching order. A topic without concepts is taught as one concept: its own id. */
  conceptIds: string[];
}

export interface ProposedChapter {
  topicId: string;
  why: string | null;
  conceptIds: readonly string[];
}

const byOrder = <T extends { order: number; id: string }>(a: T, b: T) => a.order - b.order || compareStrings(a.id, b.id);

/**
 * Stable topological order: repeatedly takes the earliest item (by its position in `items`) whose prerequisites
 * are all placed. A cycle is broken at the earliest remaining item, so the result always contains every item once.
 */
export function stableTopoOrder(items: readonly string[], prereqsOf: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const present = new Set(items);
  const placed = new Set<string>();
  const out: string[] = [];
  const remaining = [...items];
  while (remaining.length) {
    let pick = remaining.findIndex((id) => [...(prereqsOf.get(id) ?? [])].every((p) => !present.has(p) || placed.has(p) || p === id));
    if (pick < 0) pick = 0;
    const [id] = remaining.splice(pick, 1);
    placed.add(id!);
    out.push(id!);
  }
  return out;
}

/** Prerequisite edges lifted to topics: a concept edge across topics becomes an edge between its topics. */
function topicEdges(topics: readonly TrailOutlineTopic[], prerequisites: readonly TrailPrerequisite[]) {
  const topicOf = new Map<string, string>();
  for (const t of topics) {
    topicOf.set(t.id, t.id);
    for (const c of t.concepts) topicOf.set(c.id, t.id);
  }
  const topicPrereqs = new Map<string, Set<string>>();
  const conceptPrereqs = new Map<string, Set<string>>();
  for (const e of prerequisites) {
    const a = topicOf.get(e.nodeId);
    const b = topicOf.get(e.prerequisiteId);
    if (!a || !b) continue;
    if (a !== b) topicPrereqs.set(a, (topicPrereqs.get(a) ?? new Set()).add(b));
    else if (e.nodeId !== a && e.prerequisiteId !== a) conceptPrereqs.set(e.nodeId, (conceptPrereqs.get(e.nodeId) ?? new Set()).add(e.prerequisiteId));
  }
  return { topicPrereqs, conceptPrereqs };
}

/**
 * Turns the model's proposal into a valid path (spec 14 §8.1): unknown or repeated topics and concepts are
 * dropped, missing ones are appended in outline order, and the order is repaired so no chapter or concept comes
 * before one of its prerequisites. With an empty proposal the result is the outline order (the fallback).
 */
export function normalizeTrailPlan(
  proposed: readonly ProposedChapter[],
  topics: readonly TrailOutlineTopic[],
  prerequisites: readonly TrailPrerequisite[],
): TrailChapter[] {
  const outline = [...topics].sort(byOrder);
  const topicById = new Map(outline.map((t) => [t.id, t]));
  const proposedById = new Map<string, ProposedChapter>();
  for (const p of proposed) if (topicById.has(p.topicId) && !proposedById.has(p.topicId)) proposedById.set(p.topicId, p);

  const order = [...proposedById.keys(), ...outline.map((t) => t.id).filter((id) => !proposedById.has(id))];
  const { topicPrereqs, conceptPrereqs } = topicEdges(outline, prerequisites);
  return stableTopoOrder(order, topicPrereqs).map((topicId) => {
    const topic = topicById.get(topicId)!;
    const own = [...topic.concepts].sort(byOrder).map((c) => c.id);
    if (own.length === 0) return { topicId, why: proposedById.get(topicId)?.why ?? null, conceptIds: [topicId] };
    const ownSet = new Set(own);
    const fromModel = [...new Set((proposedById.get(topicId)?.conceptIds ?? []).filter((id) => ownSet.has(id)))];
    const conceptOrder = [...fromModel, ...own.filter((id) => !fromModel.includes(id))];
    return { topicId, why: proposedById.get(topicId)?.why ?? null, conceptIds: stableTopoOrder(conceptOrder, conceptPrereqs) };
  });
}

/** Stable fingerprint of what a plan was built from: topic and concept ids in outline order. */
export function trailOutlineHash(topics: readonly TrailOutlineTopic[]): string {
  const text = [...topics]
    .sort(byOrder)
    .map((t) => `${t.id}:${[...t.concepts].sort(byOrder).map((c) => c.id).join(',')}`)
    .join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------- steps

export type TrailStepPurpose = TrailStepPurposeName;
export type TrailStepStatus = TrailStepStatusName;

export interface TrailStepView {
  id: string;
  conceptId: string;
  purpose: TrailStepPurpose;
  /** Chapter-test round (1, 2…) for checkpoint steps and the re-teaching after a failed round; 0 otherwise. */
  round: number;
  status: TrailStepStatus;
  /** Questions once answered. */
  correct: boolean | null;
  /** Remedial steps: the wrong answer they repair. */
  forStepId: string | null;
  /** Creation order (ready steps are served in this order). */
  createdSeq: number;
  /** Set when the step was shown; a shown step that is still `ready` is where the student left off. */
  servedSeq: number | null;
}

export type TrailNeed =
  | { kind: 'teach'; conceptId: string }
  | { kind: 'remediate'; conceptId: string; forStepId: string; round: number }
  | { kind: 'checkpoint'; round: number };

export type TrailMove = { kind: 'serve'; stepId: string } | { kind: 'need'; need: TrailNeed } | { kind: 'chapter_passed' };

export type TrailConceptState = 'cleared' | 'shaky' | 'current' | 'upcoming';

const isQuestion = (s: TrailStepView) => s.purpose === 'practice' || s.purpose === 'remedial_question' || s.purpose === 'checkpoint';
const byCreated = (a: TrailStepView, b: TrailStepView) => a.createdSeq - b.createdSeq;
const byServed = (a: TrailStepView, b: TrailStepView) => (a.servedSeq ?? 0) - (b.servedSeq ?? 0) || a.createdSeq - b.createdSeq;

/** Answered learning-phase questions of a concept, in the order they were answered. */
function conceptAnswers(steps: readonly TrailStepView[], conceptId: string): TrailStepView[] {
  return steps
    .filter((s) => s.conceptId === conceptId && s.status === 'done' && s.round === 0 && (s.purpose === 'practice' || s.purpose === 'remedial_question'))
    .sort(byServed);
}

/** Cleared (2 right), shaky (5 answers without that) or still open. */
export function conceptOutcome(steps: readonly TrailStepView[], conceptId: string): 'cleared' | 'shaky' | 'open' {
  const answers = conceptAnswers(steps, conceptId);
  if (answers.filter((s) => s.correct).length >= TRAIL.clearCorrect) return 'cleared';
  if (answers.length >= TRAIL.maxConceptQuestions) return 'shaky';
  return 'open';
}

/** Number of chapter-test questions: 2 per concept, 4 to 10. */
export function checkpointSize(conceptCount: number): number {
  return Math.min(TRAIL.checkpointMax, Math.max(TRAIL.checkpointMin, conceptCount * TRAIL.checkpointPerConcept));
}

/** The remedial pair (lesson, question) that repairs one wrong answer: serve whichever is still open. */
function remedialMove(steps: readonly TrailStepView[], wrong: TrailStepView, round: number): TrailMove | null {
  const pair = steps.filter((s) => s.forStepId === wrong.id && (s.purpose === 'remedial_lesson' || s.purpose === 'remedial_question'));
  if (pair.length === 0) return { kind: 'need', need: { kind: 'remediate', conceptId: wrong.conceptId, forStepId: wrong.id, round } };
  const lessonFirst = (s: TrailStepView) => (s.purpose === 'remedial_lesson' ? 0 : 1);
  const open = pair.filter((s) => s.status === 'ready').sort((a, b) => lessonFirst(a) - lessonFirst(b) || byCreated(a, b));
  return open[0] ? { kind: 'serve', stepId: open[0].id } : null;
}

/** Score of a finished chapter-test round, or null while questions remain. */
export function checkpointScore(steps: readonly TrailStepView[], round: number): { correct: number; total: number; passed: boolean } | null {
  const qs = steps.filter((s) => s.purpose === 'checkpoint' && s.round === round && s.status !== 'discarded');
  if (qs.length === 0 || qs.some((s) => s.status !== 'done')) return null;
  const correct = qs.filter((s) => s.correct).length;
  return { correct, total: qs.length, passed: correct / qs.length >= TRAIL.checkpointPass };
}

/**
 * The next thing the student does in a chapter (spec 14 §8.2): resume a shown step; else, for the first open
 * concept, its lesson, the re-teaching of its last wrong answer, then its next question; once every concept is
 * cleared or shaky, the chapter test; after a failed round, re-teach the missed concepts and run a new round.
 * `need` means that content must be generated first.
 */
export function nextTrailMove(chapter: TrailChapter, steps: readonly TrailStepView[]): TrailMove {
  const open = steps.filter((s) => s.status === 'ready' && s.servedSeq !== null).sort(byServed);
  if (open[0]) return { kind: 'serve', stepId: open[0].id };

  const round = Math.max(0, ...steps.filter((s) => s.purpose === 'checkpoint').map((s) => s.round));
  if (round > 0) {
    const pending = steps.filter((s) => s.purpose === 'checkpoint' && s.round === round && s.status === 'ready').sort(byCreated);
    if (pending[0]) return { kind: 'serve', stepId: pending[0].id };
    const score = checkpointScore(steps, round);
    if (!score || score.passed) return { kind: 'chapter_passed' };
    const wrong = steps.filter((s) => s.purpose === 'checkpoint' && s.round === round && s.status === 'done' && s.correct === false);
    const missed = chapter.conceptIds.filter((c) => wrong.some((w) => w.conceptId === c)).slice(0, TRAIL.remediationsAfterCheckpoint);
    for (const conceptId of missed) {
      const first = wrong.filter((w) => w.conceptId === conceptId).sort(byServed)[0]!;
      const move = remedialMove(steps, first, round);
      if (move) return move;
    }
    return { kind: 'need', need: { kind: 'checkpoint', round: round + 1 } };
  }

  for (const conceptId of chapter.conceptIds) {
    if (conceptOutcome(steps, conceptId) !== 'open') continue;
    const lesson = steps.find((s) => s.conceptId === conceptId && s.purpose === 'lesson' && s.status !== 'discarded');
    if (!lesson) return { kind: 'need', need: { kind: 'teach', conceptId } };
    if (lesson.status === 'ready') return { kind: 'serve', stepId: lesson.id };
    const answers = conceptAnswers(steps, conceptId);
    const last = answers.at(-1);
    if (last && last.correct === false) {
      const move = remedialMove(steps, last, 0);
      if (move) return move;
    }
    const next = steps.filter((s) => s.conceptId === conceptId && s.purpose === 'practice' && s.status === 'ready').sort(byCreated)[0];
    if (next) return { kind: 'serve', stepId: next.id };
    // Out of practice questions without clearing: re-teach from the last wrong answer (or the last answer).
    const anchor = [...answers].reverse().find((s) => s.correct === false) ?? last;
    if (anchor) return { kind: 'need', need: { kind: 'remediate', conceptId, forStepId: anchor.id, round: 0 } };
    return { kind: 'need', need: { kind: 'teach', conceptId } };
  }
  return { kind: 'need', need: { kind: 'checkpoint', round: 1 } };
}

/** The concept the student is on (null in the chapter test). */
export function currentConcept(chapter: TrailChapter, steps: readonly TrailStepView[]): string | null {
  if (steps.some((s) => s.purpose === 'checkpoint')) return null;
  return chapter.conceptIds.find((c) => conceptOutcome(steps, c) === 'open') ?? null;
}

export function conceptStates(chapter: TrailChapter, steps: readonly TrailStepView[]): Array<{ conceptId: string; state: TrailConceptState }> {
  const current = currentConcept(chapter, steps);
  return chapter.conceptIds.map((conceptId) => {
    const outcome = conceptOutcome(steps, conceptId);
    if (outcome !== 'open') return { conceptId, state: outcome };
    return { conceptId, state: conceptId === current ? 'current' : 'upcoming' };
  });
}

/**
 * Content to prepare, blocking first (spec 14 §8.3, the buffer): what the next move needs now, then one step of
 * lookahead — the next concept's lesson, the chapter test while on the last concept, or the next chapter's first
 * lesson during the test. At most one blocking need and TRAIL.lookahead lookaheads.
 */
export function trailNeeds(
  chapter: TrailChapter,
  steps: readonly TrailStepView[],
  nextChapter: { chapter: TrailChapter; steps: readonly TrailStepView[] } | null,
): Array<{ need: TrailNeed; blocking: boolean; nextChapter: boolean }> {
  const out: Array<{ need: TrailNeed; blocking: boolean; nextChapter: boolean }> = [];
  const move = nextTrailMove(chapter, steps);
  if (move.kind === 'need') out.push({ need: move.need, blocking: true, nextChapter: false });

  const inTest = steps.some((s) => s.purpose === 'checkpoint') || (move.kind === 'need' && move.need.kind === 'checkpoint');
  const current = currentConcept(chapter, steps);
  if (!inTest && current) {
    const after = chapter.conceptIds.slice(chapter.conceptIds.indexOf(current) + 1).filter((c) => conceptOutcome(steps, c) === 'open');
    const upcoming = after.filter((c) => !steps.some((s) => s.conceptId === c && s.purpose === 'lesson')).slice(0, TRAIL.lookahead);
    for (const conceptId of upcoming) out.push({ need: { kind: 'teach', conceptId }, blocking: false, nextChapter: false });
    if (upcoming.length === 0 && after.length === 0) out.push({ need: { kind: 'checkpoint', round: 1 }, blocking: false, nextChapter: false });
  } else if (inTest && nextChapter) {
    const first = nextChapter.chapter.conceptIds[0];
    if (first && !nextChapter.steps.some((s) => s.conceptId === first && s.purpose === 'lesson')) {
      out.push({ need: { kind: 'teach', conceptId: first }, blocking: false, nextChapter: true });
    }
  }

  const seen = new Set<string>();
  return out
    .filter((n) => {
      const key = `${n.nextChapter}:${JSON.stringify(n.need)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 1 + TRAIL.lookahead);
}

/** Share of a chapter done: each concept counts one unit, the chapter test one more. */
export function chapterFraction(chapter: TrailChapter, steps: readonly TrailStepView[]): number {
  const units = chapter.conceptIds.length + 1;
  const concepts = chapter.conceptIds.filter((c) => conceptOutcome(steps, c) !== 'open').length;
  const round = Math.max(0, ...steps.filter((s) => s.purpose === 'checkpoint').map((s) => s.round));
  const passed = round > 0 && checkpointScore(steps, round)?.passed === true;
  return (concepts + (passed ? 1 : 0)) / units;
}

/** Whole-path progress (0–1): finished chapters plus the share of the current one. */
export function trailProgress(chapterCount: number, chapterIndex: number, currentFraction: number): number {
  if (chapterCount === 0) return 0;
  if (chapterIndex >= chapterCount) return 1;
  return Math.min(1, (chapterIndex + Math.max(0, Math.min(1, currentFraction))) / chapterCount);
}

/**
 * Concepts the chapter test should weight (shaky first, then cleared with a wrong answer, then the rest), and
 * how many questions each gets. Every concept gets at least one question while the test size allows.
 */
export function checkpointBlueprint(chapter: TrailChapter, steps: readonly TrailStepView[]): Array<{ conceptId: string; count: number }> {
  const size = checkpointSize(chapter.conceptIds.length);
  const weak = (c: string) => {
    const answers = conceptAnswers(steps, c);
    if (conceptOutcome(steps, c) === 'shaky') return 2;
    const missedCheckpoint = steps.some((s) => s.conceptId === c && s.purpose === 'checkpoint' && s.correct === false);
    return answers.some((a) => a.correct === false) || missedCheckpoint ? 1 : 0;
  };
  const ranked = chapter.conceptIds.map((c, i) => ({ c, i, w: weak(c) })).sort((a, b) => b.w - a.w || a.i - b.i);
  if (ranked.length === 0) return [];
  const counts = new Map<string, number>(chapter.conceptIds.map((c) => [c, 0]));
  let left = size;
  const give = (list: typeof ranked) => {
    for (const { c } of list) {
      if (left === 0) return;
      counts.set(c, (counts.get(c) ?? 0) + 1);
      left -= 1;
    }
  };
  // One each, then an extra one per weakness level, then round-robin until the test is full.
  give(ranked);
  give(ranked.filter((r) => r.w >= 1));
  give(ranked.filter((r) => r.w >= 2));
  while (left > 0) give(ranked);
  return chapter.conceptIds.map((c) => ({ conceptId: c, count: counts.get(c) ?? 0 })).filter((x) => x.count > 0);
}
