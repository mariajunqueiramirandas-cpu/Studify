// Ensine o Lucas (INT-02): the evaluation state the server folds turn by turn, the score (spec 12 §8.6,
// learning-engine §19.1), the results lists and the mastery evidence. Pure functions; the hidden plan and the
// state never reach the app before the results screen (INT-02.3), so only the server calls most of these.
import type { TeachingLength } from '../core/enums.ts';
import type { SourcePage } from '../core/citations.ts';

type SourcePages = SourcePage[];

/** INT-02.2: Rápido has 6 student turns, Completo 12. */
export const LUCAS_TURNS: Readonly<Record<TeachingLength, number>> = { short: 6, full: 12 };

/** Spec 12 §8.6: a lesson that ends before turn 4 gets no score. */
export const LUCAS_MIN_TURNS_FOR_SCORE = 4;

/** Spec 12 §8.5: Lucas's replies are chat-sized. */
export const LUCAS_REPLY_MAX_WORDS = 60;

export type MisconceptionStatus = 'hidden' | 'revealed' | 'partially_fixed' | 'fixed';
export type ConceptQuality = 'correct' | 'partial' | 'wrong';
export type TaughtErrorSeverity = 'minor' | 'major';

export interface LucasPlanMisconception {
  id: string;
  lucas_belief: string;
  correct_concept: string;
  fix_criteria: string[];
  trigger: 'early' | 'mid' | 'late';
  source_pages: SourcePages;
}

export interface LucasPlanConcept {
  id: string;
  statement: string;
  /** The knowledge-map concept this key concept is about, when known (mastery evidence). */
  node_id?: string | null;
  source_pages: SourcePages;
}

/** The hidden lesson plan (spec 12 §7.2). */
export interface LucasPlan {
  key_concepts: LucasPlanConcept[];
  misconceptions: LucasPlanMisconception[];
  naive_questions: string[];
  opener: string;
}

export interface TaughtError {
  claim: string;
  correction: string;
  severity: TaughtErrorSeverity;
  source_pages: SourcePages;
  /** Key concept the wrong claim is about, when the evaluator could tell. */
  concept_id?: string | null;
}

/** What one Lucas turn reports (spec 12 §7.3 `evaluation`). */
export interface LucasTurnEvaluation {
  misconception_updates: { id: string; status: MisconceptionStatus }[];
  concepts_covered: { id: string; quality: ConceptQuality }[];
  errors_taught: TaughtError[];
  clarity_signals: { used_example: boolean; used_analogy: boolean; checked_understanding: boolean };
}

/** The folded evaluation state (teaching_sessions.evaluation_state). */
export interface LucasEvaluationState {
  misconceptions: Record<string, MisconceptionStatus>;
  concepts: Record<string, ConceptQuality | 'uncovered'>;
  errors_taught: TaughtError[];
  clarity: { used_example: boolean; used_analogy: boolean; checked_understanding: boolean };
}

const STATUS_RANK: Readonly<Record<MisconceptionStatus, number>> = { hidden: 0, revealed: 1, partially_fixed: 2, fixed: 3 };
const QUALITY_RANK: Readonly<Record<ConceptQuality | 'uncovered', number>> = { uncovered: -1, wrong: 0, partial: 1, correct: 2 };

export function initialLucasState(plan: Pick<LucasPlan, 'key_concepts' | 'misconceptions'>): LucasEvaluationState {
  return {
    misconceptions: Object.fromEntries(plan.misconceptions.map((m) => [m.id, 'hidden' as const])),
    concepts: Object.fromEntries(plan.key_concepts.map((c) => [c.id, 'uncovered' as const])),
    errors_taught: [],
    clarity: { used_example: false, used_analogy: false, checked_understanding: false },
  };
}

function normalizeClaim(claim: string): string {
  return claim
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Folds one turn's evaluation into the state. Progress is monotonic: a misconception never goes back from
 * `fixed` (Lucas got it), and a concept keeps its best explanation. Unknown ids (the model inventing a
 * misconception or concept outside the plan) are ignored, so the plan stays the only scoring base.
 * A wrong explanation is kept as `wrong` only until a better one arrives; taught errors are recorded apart.
 */
export function applyLucasEvaluation(state: LucasEvaluationState, evaluation: LucasTurnEvaluation): LucasEvaluationState {
  const misconceptions = { ...state.misconceptions };
  for (const update of evaluation.misconception_updates) {
    const current = misconceptions[update.id];
    if (current === undefined) continue;
    if (STATUS_RANK[update.status] > STATUS_RANK[current]) misconceptions[update.id] = update.status;
  }
  const concepts = { ...state.concepts };
  for (const covered of evaluation.concepts_covered) {
    const current = concepts[covered.id];
    if (current === undefined) continue;
    if (QUALITY_RANK[covered.quality] > QUALITY_RANK[current]) concepts[covered.id] = covered.quality;
  }
  const seen = new Set(state.errors_taught.map((e) => normalizeClaim(e.claim)));
  const errors = [...state.errors_taught];
  for (const error of evaluation.errors_taught) {
    const key = normalizeClaim(error.claim);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    errors.push(error);
  }
  return {
    misconceptions,
    concepts,
    errors_taught: errors,
    clarity: {
      used_example: state.clarity.used_example || evaluation.clarity_signals.used_example,
      used_analogy: state.clarity.used_analogy || evaluation.clarity_signals.used_analogy,
      checked_understanding: state.clarity.checked_understanding || evaluation.clarity_signals.checked_understanding,
    },
  };
}

export interface LucasRubric {
  misconceptions: number;
  coverage: number;
  accuracy: number;
  clarity: number;
}

/**
 * Spec 12 §8.6 rubric, in points: misconceptions fixed (40), key concepts covered (25), accuracy (20),
 * clarity (15). With no misconception in the plan (§9 "fewer than 3"), their 40 points move to coverage.
 */
export function lucasRubric(state: LucasEvaluationState): LucasRubric {
  const misconceptionValues = Object.values(state.misconceptions);
  const conceptValues = Object.values(state.concepts);
  const fixedShare =
    misconceptionValues.length === 0
      ? 0
      : misconceptionValues.reduce((sum, s) => sum + (s === 'fixed' ? 1 : s === 'partially_fixed' ? 0.5 : 0), 0) /
        misconceptionValues.length;
  const coverageShare =
    conceptValues.length === 0
      ? 0
      : conceptValues.reduce((sum, q) => sum + (q === 'correct' ? 1 : q === 'partial' ? 0.5 : 0), 0) / conceptValues.length;
  const majors = state.errors_taught.filter((e) => e.severity === 'major').length;
  const minors = state.errors_taught.length - majors;
  const misconceptionPoints = misconceptionValues.length === 0 ? 0 : 40;
  const coveragePoints = misconceptionValues.length === 0 ? 65 : 25;
  return {
    misconceptions: misconceptionPoints * fixedShare,
    coverage: coveragePoints * coverageShare,
    accuracy: Math.max(0, 20 - 10 * majors - 5 * minors),
    clarity: 5 * Number(state.clarity.used_example) + 5 * Number(state.clarity.used_analogy) + 5 * Number(state.clarity.checked_understanding),
  };
}

/** Score 0–100 "Quanto o Lucas entendeu", or "too_short" before turn 4 (learning-engine §19.1). */
export function lucasScore(state: LucasEvaluationState, turns: number): number | 'too_short' {
  if (turns < LUCAS_MIN_TURNS_FOR_SCORE) return 'too_short';
  const r = lucasRubric(state);
  return Math.max(0, Math.min(100, Math.round(r.misconceptions + r.coverage + r.accuracy + r.clarity)));
}

export type LucasBand = 'confused' | 'almost' | 'good' | 'born_teacher';

/** Spec 12 §5.2 bands. */
export function lucasBand(score: number): LucasBand {
  if (score >= 90) return 'born_teacher';
  if (score >= 70) return 'good';
  if (score >= 40) return 'almost';
  return 'confused';
}

export interface LucasGap {
  kind: 'misconception' | 'concept';
  id: string;
  /** What Lucas still believes, or the concept statement that was not taught well. */
  text: string;
  correct: string;
  source_pages: SourcePages;
  node_id?: string | null;
}

/** INT-02.7 "Pontos que ficaram faltando": unfixed misconceptions, then uncovered or poorly taught concepts. */
export function lucasGaps(plan: LucasPlan, state: LucasEvaluationState): LucasGap[] {
  const gaps: LucasGap[] = [];
  for (const m of plan.misconceptions) {
    const status = state.misconceptions[m.id] ?? 'hidden';
    if (status === 'fixed') continue;
    gaps.push({ kind: 'misconception', id: m.id, text: m.lucas_belief, correct: m.correct_concept, source_pages: m.source_pages });
  }
  for (const c of plan.key_concepts) {
    const quality = state.concepts[c.id] ?? 'uncovered';
    if (quality === 'correct') continue;
    gaps.push({ kind: 'concept', id: c.id, text: c.statement, correct: c.statement, source_pages: c.source_pages, node_id: c.node_id ?? null });
  }
  return gaps;
}

export interface LucasEvidence {
  concept_id: string;
  node_id: string | null;
  /** Evidence score s: 1 correct, 0.5 partial, 0 wrong (learning-engine §5.2). */
  score: number;
}

/**
 * INT-02.8: one evidence item per key concept the student explained (uncovered concepts give none);
 * a major taught error about a concept forces s = 0 for it.
 */
export function lucasEvidence(plan: LucasPlan, state: LucasEvaluationState): LucasEvidence[] {
  const majorConcepts = new Set(state.errors_taught.filter((e) => e.severity === 'major' && e.concept_id).map((e) => e.concept_id as string));
  const out: LucasEvidence[] = [];
  for (const c of plan.key_concepts) {
    const quality = state.concepts[c.id] ?? 'uncovered';
    if (quality === 'uncovered') continue;
    const base = quality === 'correct' ? 1 : quality === 'partial' ? 0.5 : 0;
    out.push({ concept_id: c.id, node_id: c.node_id ?? null, score: majorConcepts.has(c.id) ? 0 : base });
  }
  return out;
}

/** Spec 12 §8.5: reveal misconceptions by their trigger window (early: turns 1–3, mid: 4–7, late: 8+). */
export function misconceptionsDue(plan: Pick<LucasPlan, 'misconceptions'>, state: LucasEvaluationState, turn: number): string[] {
  const window = turn <= 3 ? 'early' : turn <= 7 ? 'mid' : 'late';
  const order = { early: 0, mid: 1, late: 2 } as const;
  return plan.misconceptions
    .filter((m) => (state.misconceptions[m.id] ?? 'hidden') === 'hidden' && order[m.trigger] <= order[window])
    .map((m) => m.id);
}

/** Opening line of every lesson (INT-02.4). */
export function lucasOpener(topicTitle: string): string {
  return `E aí! Faltei na aula de ${topicTitle} 😅 Me explica?`;
}
