import { z } from 'zod';
import { MistakeCause, RemediationCard, SourcePages } from './common.ts';

const CriterionVerdict = z.strictObject({
  id: z.string().min(1).max(8),
  verdict: z.enum(['full', 'partial', 'none']),
  points: z.number().min(0).max(100),
  justification: z.string().min(1).max(300),
});

/** PRA-01.6 short-answer grade. `score` = Σ points / max_points, validated in code. */
export const ShortAnswerGrade = z.strictObject({
  score: z.number().min(0).max(1),
  criteria: z.array(CriterionVerdict).min(1).max(8),
  feedback: z.string().min(1).max(600),
  missing: z
    .array(
      z.strictObject({
        point: z.string().min(1).max(200),
        pages: z.array(z.number().int().min(1)).min(1).max(12),
      }),
    )
    .max(6),
  suggested_cause: MistakeCause,
  remediation_card: RemediationCard.nullable(),
  grader_confidence: z.enum(['low', 'medium', 'high']),
});

/** PRA-02.1 explanation for a wrong answer, used when the stored question has no rationale yet. */
export const WrongAnswerExplanation = z.strictObject({
  explanation_md: z.string().min(1).max(1200),
  chosen_option_rationale_md: z.string().min(1).max(500).nullable(),
  source_pages: SourcePages,
});

/** PRA-04.4 contrast drill: side-by-side comparison of two confused concepts. */
export const ContrastTable = z.strictObject({
  title: z.string().min(1).max(120),
  rows: z
    .array(z.strictObject({ aspect: z.string().min(1).max(60), a: z.string().min(1).max(200), b: z.string().min(1).max(200) }))
    .min(2)
    .max(6),
  key_difference: z.string().min(1).max(300),
  example: z.string().min(1).max(300),
  source_pages: SourcePages,
});
