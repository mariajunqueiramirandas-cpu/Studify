// Suggested mistake cause for auto-graded answers (PRA-02.2, PRA-04.2; spec 05 §8.5). No AI call.
// The rule order itself lives in learning/mistakes.ts (suggestCause, first match wins). This module
// derives the inputs that rule reads from the question and the learner's response.
import type { MistakeCause, QuestionType } from '../core/index.ts';
import { suggestCause, type AnswerFacts } from '../learning/mistakes.ts';
import type { MultiSelectPayload, McqSinglePayload, QuestionPayload, QuestionResponse } from './payloads.ts';
import { stripAccents } from './text.ts';

// Qualifiers in capitals (§8.2 rule 6): NÃO, INCORRETA(S), EXCETO, FALSA(S). Accents are stripped first
// so "NÃO" and "NAO" both match. The class-based boundaries avoid regex lookbehind (Hermes).
const NEGATIVE_QUALIFIER = /(^|[^A-Za-z])(NAO|INCORRETAS?|EXCETO|FALSAS?)(?![A-Za-z])/;

/** True when the stem carries a negative qualifier written in capitals (spec 05 §8.5 rule 1). */
export function hasNegativeQualifier(stem: string): boolean {
  return NEGATIVE_QUALIFIER.test(stripAccents(stem));
}

/** Inputs for suggestMistakeCause. Read-only facts about one answered question. */
export interface MistakeCauseInput {
  /** Question type; selects how the picked alternative is read. */
  type: QuestionType;
  /** Stem text, checked for negative qualifiers. */
  stem: string;
  /** Validated payload for `type` (parseQuestionPayload). */
  payload: QuestionPayload;
  /** Learner response, or null when the question was skipped. */
  response: QuestionResponse | null;
  /** Medidor de Confiança rating 1–4 (PRA-05), or null when not rated. */
  confidence: 1 | 2 | 3 | 4 | null;
  /** Seconds spent on the question. */
  timeSeconds: number;
  /** Median seconds for this question across users, or null when unknown (rule 3 then uses 15 s). */
  medianTimeSeconds: number | null;
}

/**
 * Reads the picked alternative. For mcq_single, a picked wrong option is a true statement when the
 * stem is negative ("NÃO", "INCORRETA"), since the key is the one false alternative. For multi_select,
 * any picked wrong option counts the same way. true_false has no alternatives, so it reports false.
 */
function pickedAlternative(
  type: QuestionType,
  payload: QuestionPayload,
  response: QuestionResponse | null,
): { pickedOptionIsTrueStatement: boolean; pickedMisconceptionConceptId: string | null } {
  const none = { pickedOptionIsTrueStatement: false, pickedMisconceptionConceptId: null };
  if (response === null) return none;

  if (type === 'mcq_single' && 'choice' in response) {
    const p = payload as McqSinglePayload;
    const option = p.options.find((o) => o.id === response.choice);
    if (option === undefined) return none;
    return {
      pickedOptionIsTrueStatement: response.choice !== p.correct,
      pickedMisconceptionConceptId: option.misconception_concept_id ?? null,
    };
  }

  // §8.1 gives multi_select options no misconception_concept_id, so only the "true statement" rule applies.
  if (type === 'multi_select' && 'choices' in response) {
    const p = payload as MultiSelectPayload;
    const correct = new Set(p.correct);
    const isTrue = response.choices.some((choice) => p.options.some((o) => o.id === choice) && !correct.has(choice));
    return { pickedOptionIsTrueStatement: isTrue, pickedMisconceptionConceptId: null };
  }

  return none;
}

/** Builds the AnswerFacts that learning's suggestCause reads (spec 05 §8.5). */
export function deriveAnswerFacts(input: MistakeCauseInput): AnswerFacts {
  const picked = pickedAlternative(input.type, input.payload, input.response);
  return {
    stemHasQualifier: hasNegativeQualifier(input.stem),
    pickedOptionIsTrueStatement: picked.pickedOptionIsTrueStatement,
    pickedMisconceptionConceptId: picked.pickedMisconceptionConceptId,
    confidence: input.confidence,
    timeSeconds: input.timeSeconds,
    medianTimeSeconds: input.medianTimeSeconds,
    skipped: input.response === null,
  };
}

/**
 * suggestMistakeCause (spec 05 §8.5), first match wins:
 *  1. negative qualifier in the stem and a true-statement alternative picked → misread;
 *  2. the picked alternative has a misconception concept → confused;
 *  3. confidence 3–4 and fast (< 40% of the median, or < 15 s without a median) → careless;
 *  4. otherwise (confidence 1–2, skipped, or slow) → didnt_know.
 * AI-graded items use the grader's own suggested_cause instead.
 */
export function suggestMistakeCause(input: MistakeCauseInput): MistakeCause {
  return suggestCause(deriveAnswerFacts(input));
}
