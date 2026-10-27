import { z } from 'zod';
import { BloomLevel, Confidence, Difficulty, DocPageRef, NodeKey } from './common.ts';
import { QUESTION_TYPES } from './questions.ts';

const Alternative = z.strictObject({ label: z.string().min(1).max(2), text_md: z.string().min(1).max(300) });

/** PRA-09.2 output. `page` is an original page number (or photo number for photographed tests). */
export const PastTestExtraction = z.strictObject({
  test: z.strictObject({
    title: z.string().min(1).max(120).nullable(),
    teacher_guess: z.string().min(1).max(80).nullable(),
    year_guess: z.number().int().min(1990).max(2100).nullable(),
    total_points: z.number().min(0).max(1000).nullable(),
    duration_guess: z.number().int().min(5).max(300).nullable(),
  }),
  questions: z
    .array(
      z.strictObject({
        position: z.number().int().min(1),
        page: z.number().int().min(1),
        type: z.enum(QUESTION_TYPES as [string, ...string[]]),
        statement_md: z.string().min(1).max(2000),
        alternatives: z.array(Alternative).min(2).max(6).nullable(),
        answer: z.strictObject({ value: z.string().min(1).max(500), source: z.enum(['printed', 'generated']) }).nullable(),
        solution_md: z.string().min(1).max(3000).nullable(),
        points: z.number().min(0).max(100).nullable(),
        format_features: z.array(z.enum(['contextualized', 'figure', 'graph', 'table', 'calculation', 'multi_part'])).max(6),
        bloom: BloomLevel,
        difficulty: Difficulty,
        node_matches: z.array(z.strictObject({ node_key: NodeKey, confidence: Confidence })).max(3),
      }),
    )
    .min(1)
    .max(80),
});

/** PRA-09.7 output: new questions for the blueprint slots (spec 08 §7.3). */
export const PredictedTest = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        slot_id: z.string().min(1).max(20),
        statement_md: z.string().min(1).max(2000),
        alternatives: z.array(Alternative).min(2).max(6).nullable(),
        answer: z.string().min(1).max(500),
        solution_md: z.string().min(1).max(3000),
        explanation_md: z.string().min(1).max(1200),
        source_pages: z.array(DocPageRef).min(1).max(6),
        rationale: z.string().min(1).max(300),
      }),
    )
    .min(1)
    .max(60),
});

/** PRA-09.4 output. Every pattern must cite at least two questions from at least two tests. */
export const TeacherPatterns = z.strictObject({
  patterns: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(300),
        evidence_question_ids: z.array(z.string().min(1).max(64)).min(2).max(10),
      }),
    )
    .max(8),
  style_notes: z.string().min(1).max(600),
  typical_command_verbs: z.array(z.string().min(1).max(30)).max(10),
});

/** Returns the indices of patterns that fail the ≥ 2 questions / ≥ 2 tests rule (spec 08 §7.2). */
export function checkPatternEvidence(
  patterns: readonly { evidence_question_ids: readonly string[] }[],
  testOfQuestion: Record<string, string>,
): number[] {
  const failing: number[] = [];
  patterns.forEach((pattern, index) => {
    const ids = new Set(pattern.evidence_question_ids);
    const tests = new Set([...ids].map((id) => testOfQuestion[id]).filter((t): t is string => Boolean(t)));
    if (ids.size < 2 || tests.size < 2) failing.push(index);
  });
  return failing;
}
