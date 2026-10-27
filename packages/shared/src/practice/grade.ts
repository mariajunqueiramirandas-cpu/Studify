// Deterministic answer grading (PRA-01.6–01.8, PRA-08.3; spec 05 §8.4, §11). The same function runs
// on device (offline quizzes), in Edge Functions (quiz-submit, authoritative) and in the worker.
import type { z } from 'zod';
import type { QuestionType } from '../core/index.ts';
import {
  FillBlankResponseSchema,
  FindErrorResponseSchema,
  McqSingleResponseSchema,
  MatchingResponseSchema,
  MultiSelectResponseSchema,
  NumericResponseSchema,
  OrderingResponseSchema,
  ProblemResponseSchema,
  TextResponseSchema,
  TrueFalseResponseSchema,
  type FillBlankPayload,
  type FindErrorPayload,
  type MatchingPayload,
  type McqSinglePayload,
  type MultiSelectPayload,
  type NumericPayload,
  type OrderingPayload,
  type ProblemPayload,
  type QuestionPayload,
  type QuestionPayloadByType,
  type QuestionResponse,
  type QuestionResponseByType,
  type TrueFalsePayload,
} from './payloads.ts';
import { matchAcceptedAnswer, parseDecimal, sameUnit } from './text.ts';
import { expressionsEquivalent } from './expression.ts';

/** Result of grading one answer. `correct` is true iff `score === 1`; both are null while pending. */
export interface PracticeGradeResult {
  correct: boolean | null;
  /** Normalized partial credit in [0, 1]. */
  score: number | null;
  /** Canonical accepted spelling when a fill_blank answer was accepted with a typo, case or accent difference (PRA-01.7). */
  typo: string | null;
  /** True when the score comes later: AI grading (short_answer, essay_question). */
  pending: boolean;
}

export interface PracticeGradeOptions {
  /** problem only: hints revealed before answering (PRA-08.2). Default 0. */
  hintsUsed?: number;
  /** problem only: the full solution was opened. Scores 0 (PRA-08.3). Default false. */
  solutionViewed?: boolean;
}

function scored(score: number, typo: string | null = null): PracticeGradeResult {
  const clamped = Math.min(1, Math.max(0, score));
  return { correct: clamped === 1, score: clamped, typo, pending: false };
}

function pending(): PracticeGradeResult {
  return { correct: null, score: null, typo: null, pending: true };
}

/**
 * Hint credit for `problem` items (PRA-08.3): 0 hints = 1.0, 1 = 0.75, 2 = 0.5, 3 = 0.25 for the
 * standard ladder of three hints, i.e. 1 − h/(total + 1). Viewing the solution gives 0.
 */
export function hintCredit(hintsUsed: number, totalHints: number, solutionViewed: boolean): number {
  if (solutionViewed) return 0;
  const total = Number.isFinite(totalHints) ? Math.max(0, Math.floor(totalHints)) : 0;
  const used = Number.isFinite(hintsUsed) ? Math.min(Math.max(0, Math.floor(hintsUsed)), total) : 0;
  return 1 - used / (total + 1);
}

/**
 * Whether this answer can be graded without AI (offline queue decision). Expression answers of `problem`
 * items are checked numerically by expression.ts (PRA-08.4), so only open text needs the server.
 */
export function isLocallyGraded(type: QuestionType, _payload: QuestionPayload): boolean {
  return type !== 'short_answer' && type !== 'essay_question';
}

/**
 * Grades one answer. `payload` must already be validated (parseQuestionPayload). `response` is the
 * learner's answer, or null when nothing was answered (score 0, no AI call). A response whose shape
 * does not match the type scores 0 rather than throwing, so a bad client payload cannot crash grading.
 */
export function gradeAnswer<T extends QuestionType>(
  type: T,
  payload: QuestionPayloadByType[T],
  response: QuestionResponseByType[T] | null,
  options: PracticeGradeOptions = {},
): PracticeGradeResult {
  return gradeUntyped(type, payload as QuestionPayload, response as QuestionResponse | null, options);
}

function gradeUntyped(
  type: QuestionType,
  payload: QuestionPayload,
  response: QuestionResponse | null,
  options: PracticeGradeOptions,
): PracticeGradeResult {
  if (response === null) return scored(0);
  switch (type) {
    case 'mcq_single':
      return gradeMcqSingle(payload as McqSinglePayload, response);
    case 'multi_select':
      return gradeMultiSelect(payload as MultiSelectPayload, response);
    case 'true_false':
      return gradeTrueFalse(payload as TrueFalsePayload, response);
    case 'fill_blank':
      return gradeFillBlank(payload as FillBlankPayload, response);
    case 'numeric':
      return gradeNumeric(payload as NumericPayload, response);
    case 'matching':
      return gradeMatching(payload as MatchingPayload, response);
    case 'ordering':
      return gradeOrdering(payload as OrderingPayload, response);
    case 'short_answer':
    case 'essay_question':
      return gradeOpenText(response);
    case 'find_error':
      return gradeFindError(payload as FindErrorPayload, response);
    case 'problem':
      return gradeProblem(payload as ProblemPayload, response, options);
  }
}

/** Parses the response against its schema; a shape mismatch scores 0. */
function scoreParsed<S extends z.ZodType>(
  schema: S,
  response: unknown,
  score: (data: z.output<S>) => number,
): PracticeGradeResult {
  const parsed = schema.safeParse(response);
  if (!parsed.success) return scored(0);
  return scored(score(parsed.data as z.output<S>));
}

function gradeMcqSingle(p: McqSinglePayload, response: unknown): PracticeGradeResult {
  return scoreParsed(McqSingleResponseSchema, response, (r) => (r.choice === p.correct ? 1 : 0));
}

/** §8.4: (TP − FP) / |correct|, clamped to [0, 1]. Repeated choices count once. */
function gradeMultiSelect(p: MultiSelectPayload, response: unknown): PracticeGradeResult {
  return scoreParsed(MultiSelectResponseSchema, response, (r) => {
    const correct = new Set(p.correct);
    let truePositives = 0;
    let falsePositives = 0;
    for (const choice of new Set(r.choices)) {
      if (correct.has(choice)) truePositives++;
      else falsePositives++;
    }
    return (truePositives - falsePositives) / correct.size;
  });
}

function gradeTrueFalse(p: TrueFalsePayload, response: unknown): PracticeGradeResult {
  return scoreParsed(TrueFalseResponseSchema, response, (r) => (r.value === p.correct ? 1 : 0));
}

/** PRA-01.7: each blank is correct when its typed text matches an accepted spelling; score = correct / total. */
function gradeFillBlank(p: FillBlankPayload, response: unknown): PracticeGradeResult {
  const parsed = FillBlankResponseSchema.safeParse(response);
  if (!parsed.success) return scored(0);
  const typos: string[] = [];
  let correctBlanks = 0;
  for (const blank of p.blanks) {
    const typed = parsed.data.blanks[String(blank.id)];
    if (typed === undefined) continue;
    const match = matchAcceptedAnswer(typed, blank.accepted);
    if (match === null) continue;
    correctBlanks++;
    if (match.typo !== null) typos.push(match.typo);
  }
  return scored(correctBlanks / p.blanks.length, typos.length > 0 ? typos.join(', ') : null);
}

/** PRA-01.7: within tolerance; the unit counts only when the item requires it. */
function gradeNumeric(p: NumericPayload, response: unknown): PracticeGradeResult {
  return scoreParsed(NumericResponseSchema, response, (r) => {
    const valueOk = withinTolerance(r.number, p.answer, p.tolerance_abs ?? 0, p.tolerance_rel ?? 0);
    const unitOk = !p.unit_required || p.unit == null || (r.unit != null && sameUnit(r.unit, p.unit));
    return valueOk && unitOk ? 1 : 0;
  });
}

/** §8.4: correct pairs / number of left items. Each left item counts once (its first pairing). */
function gradeMatching(p: MatchingPayload, response: unknown): PracticeGradeResult {
  return scoreParsed(MatchingResponseSchema, response, (r) => {
    const answered = new Map<string, string>();
    for (const [left, right] of r.pairs) {
      if (!answered.has(left)) answered.set(left, right);
    }
    let correctPairs = 0;
    for (const [left, right] of p.pairs) {
      if (answered.get(left) === right) correctPairs++;
    }
    return correctPairs / p.left.length;
  });
}

/**
 * §8.4: Kendall tau, 1 − discordant / total pairs. An order that is not a permutation of the items
 * scores 0 (the UI always submits every item).
 */
function gradeOrdering(p: OrderingPayload, response: unknown): PracticeGradeResult {
  return scoreParsed(OrderingResponseSchema, response, (r) => {
    const ids = p.correct_order;
    const idSet = new Set(ids);
    const isPermutation =
      r.order.length === ids.length && new Set(r.order).size === ids.length && r.order.every((id) => idSet.has(id));
    if (!isPermutation) return 0;
    const position = new Map(r.order.map((id, index) => [id, index] as const));
    let total = 0;
    let discordant = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        total++;
        if ((position.get(ids[i]!) ?? 0) > (position.get(ids[j]!) ?? 0)) discordant++;
      }
    }
    return total === 0 ? 1 : (total - discordant) / total;
  });
}

/** short_answer / essay_question (PRA-01.6, PRA-07): empty text scores 0 without AI; otherwise pending. */
function gradeOpenText(response: unknown): PracticeGradeResult {
  const parsed = TextResponseSchema.safeParse(response);
  if (!parsed.success) return scored(0);
  return parsed.data.text.trim() === '' ? scored(0) : pending();
}

/** find_error (PRA-06.4): the planted segment, or null for "Não tem erro". */
function gradeFindError(p: FindErrorPayload, response: unknown): PracticeGradeResult {
  return scoreParsed(FindErrorResponseSchema, response, (r) => (r.segment_id === p.error_segment_id ? 1 : 0));
}

/** problem (PRA-08.3–08.4): correctness × hint credit. Expressions are compared at random points (expression.ts). */
function gradeProblem(p: ProblemPayload, response: unknown, options: PracticeGradeOptions): PracticeGradeResult {
  if (options.solutionViewed ?? false) return scored(0);
  const parsed = ProblemResponseSchema.safeParse(response);
  if (!parsed.success) return scored(0);
  if (!problemVerdict(p, parsed.data.answer)) return scored(0);
  return scored(hintCredit(options.hintsUsed ?? 0, p.hints.length, false));
}

function problemVerdict(p: ProblemPayload, answer: string): boolean {
  if (p.answer_format === 'expression') {
    if (answer.trim() === '') return false;
    return expressionsEquivalent(answer, String(p.final_answer));
  }
  if (p.answer_format === 'choice') return foldChoice(answer) === foldChoice(String(p.final_answer));
  const typed = parseDecimal(answer);
  const expected = typeof p.final_answer === 'number' ? p.final_answer : parseDecimal(p.final_answer);
  if (typed === null || expected === null) return false;
  return withinTolerance(typed, expected, p.tolerance ?? 0, 0);
}

function foldChoice(value: string): string {
  return value.trim().toUpperCase().replace(/[).\s]/g, '');
}

/** |actual − expected| ≤ max(abs, rel·|expected|), with a float-noise allowance. */
export function withinTolerance(actual: number, expected: number, toleranceAbs = 0, toleranceRel = 0): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  const allowed = Math.max(toleranceAbs, toleranceRel * Math.abs(expected));
  const noise = 1e-9 * Math.max(1, Math.abs(expected));
  return Math.abs(actual - expected) <= allowed + noise;
}
