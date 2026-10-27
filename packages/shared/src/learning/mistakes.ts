// Caderno de Erros (learning-engine §7; PRA-04, spec 05 §8.5).
import { MISTAKES } from './params.ts';
import { addDays, daysBetween } from './time.ts';
import type { LocalDate } from './types.ts';

export type MistakeCause = 'didnt_know' | 'confused' | 'careless' | 'misread';

export type RePracticeStep =
  | 'concept_notes'
  | 'remediation_card'
  | 'variant_question'
  | 'contrast_drill'
  | 'same_question_slow_mode'
  | 'tip'
  | 'same_question_qualifiers_highlighted'
  | 'qualifier_question';

/** Facts about one answer that the cause heuristic reads (§7.1). */
export interface AnswerFacts {
  /** The stem contains NÃO / INCORRETA / EXCETO / FALSA. */
  stemHasQualifier: boolean;
  /** The picked option is a true statement (relevant only with a qualifier). */
  pickedOptionIsTrueStatement: boolean;
  /** The picked option is linked to a misconception concept, if any. */
  pickedMisconceptionConceptId?: string | null;
  /** Confidence 1–4 (PRA-05), or null when not rated. */
  confidence: 1 | 2 | 3 | 4 | null;
  timeSeconds: number;
  /** Median time for this question across users, null when unknown. */
  medianTimeSeconds: number | null;
  skipped: boolean;
}

/**
 * suggestCause (§7.1, spec 05 §8.5). The first matching rule wins:
 *  1. qualifier in the stem and a true-statement option picked → misread;
 *  2. misconception option picked → confused;
 *  3. confidence ≥ 3 and fast (< 40% of median, or < 15 s without a median) → careless;
 *  4. otherwise → didnt_know (low confidence, skipped, or more than twice the median time).
 */
export function suggestCause(a: AnswerFacts): MistakeCause {
  if (a.stemHasQualifier && a.pickedOptionIsTrueStatement) return 'misread';
  if (a.pickedMisconceptionConceptId) return 'confused';
  const median = a.medianTimeSeconds;
  const fast = median !== null && median > 0 ? a.timeSeconds < 0.4 * median : a.timeSeconds < 15;
  if ((a.confidence ?? 0) >= 3 && fast) return 'careless';
  return 'didnt_know';
}

/** Re-practice plan by cause (§7.2, PRA-04.4). */
export function rePracticeFor(cause: MistakeCause): RePracticeStep[] {
  switch (cause) {
    case 'didnt_know':
      return ['concept_notes', 'remediation_card', 'variant_question'];
    case 'confused':
      return ['contrast_drill', 'variant_question'];
    case 'careless':
      return ['same_question_slow_mode', 'tip'];
    case 'misread':
      return ['same_question_qualifiers_highlighted', 'qualifier_question'];
  }
}

/**
 * Whether a graded answer creates a Caderno entry (PRA-04.1): wrong or partial below 0.5 create one;
 * a correct answer rated "Chutando" (confidence 1) is offered "Salvar no caderno".
 */
export function mistakeEntryAction(score: number, confidence: 1 | 2 | 3 | 4 | null): 'create' | 'offer' | 'none' {
  if (score < 0.5) return 'create';
  if (score >= 1 && confidence === 1) return 'offer';
  return 'none';
}

/** Retry state of one Caderno entry (§7.3). Days are study days (LocalDate). */
export interface RetrySchedule {
  /** Study day the current retry cycle started (the mistake day, or the last wrong retry). */
  baseDay: LocalDate;
  /** Index into MISTAKES.retryOffsets for the next retry. */
  retryIndex: number;
  /** Distinct study days on which a retry was answered correctly in this cycle. */
  correctDays: LocalDate[];
  resolved: boolean;
}

export function newRetrySchedule(mistakeDay: LocalDate): RetrySchedule {
  return { baseDay: mistakeDay, retryIndex: 0, correctDays: [], resolved: false };
}

/**
 * Applies a retry outcome on study day `today` (§7.3):
 *  - correct: add today to correct_days; two distinct correct days resolve the entry;
 *  - wrong: the schedule restarts at +1 study day and correct_days is cleared.
 */
export function applyRetryOutcome(s: RetrySchedule, outcome: 'correct' | 'wrong', today: LocalDate): RetrySchedule {
  if (s.resolved) return s;
  if (outcome === 'wrong') {
    return { baseDay: today, retryIndex: 0, correctDays: [], resolved: false };
  }
  const correctDays = s.correctDays.includes(today) ? [...s.correctDays] : [...s.correctDays, today].sort();
  const resolved = correctDays.length >= MISTAKES.correctDaysToResolve;
  const lastIndex = MISTAKES.retryOffsets.length - 1;
  return {
    baseDay: s.baseDay,
    retryIndex: Math.min(s.retryIndex + 1, lastIndex),
    correctDays,
    resolved,
  };
}

/**
 * nextRetry (§7.3): the next retry day, or "resolved". Pass the outcome of the retry just answered
 * (and today's study day) to advance the schedule first; omit both to read the current schedule.
 */
export function nextRetry(s: RetrySchedule, outcome?: 'correct' | 'wrong', today?: LocalDate): LocalDate | 'resolved' {
  const current = outcome && today ? applyRetryOutcome(s, outcome, today) : s;
  if (current.resolved) return 'resolved';
  const lastIndex = MISTAKES.retryOffsets.length - 1;
  const offset = MISTAKES.retryOffsets[Math.min(current.retryIndex, lastIndex)] ?? 1;
  return addDays(current.baseDay, offset);
}

/** Entries whose next retry is today or earlier, for "Refazer erros" and the Feed (pool M). */
export function retriesDue<T extends { id: string; schedule: RetrySchedule }>(entries: readonly T[], today: LocalDate): T[] {
  return entries.filter((e) => {
    const next = nextRetry(e.schedule);
    return next !== 'resolved' && daysBetween(next, today) >= 0;
  });
}
