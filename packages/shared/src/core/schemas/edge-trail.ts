// API payloads of the Trilha (TRL-01, spec 14; api.md §4.11): open (or resume) a subject's path, prepare the
// next steps' content, answer a step. The client never sees a question's answer before answering it.
import { z } from 'zod';
import { TRAIL_STATUS, TRAIL_STEP_PURPOSE } from '../enums.ts';
import { SourcePagesSchema } from '../citations.ts';
import { UuidSchema } from './common.ts';

export const TrailTermSchema = z.object({ term: z.string(), definition: z.string() });
export type TrailTerm = z.infer<typeof TrailTermSchema>;

const StepBase = {
  id: UuidSchema,
  purpose: z.enum(TRAIL_STEP_PURPOSE),
  concept_id: UuidSchema,
  concept_title: z.string(),
  terms: z.array(TrailTermSchema),
  source_pages: SourcePagesSchema,
};

export const TrailStepSchema = z.discriminatedUnion('kind', [
  z.object({ ...StepBase, kind: z.literal('lesson'), title: z.string(), body: z.string() }),
  z.object({
    ...StepBase,
    kind: z.literal('question'),
    stem: z.string(),
    options: z.array(z.object({ id: z.string(), text: z.string() })),
    /** Chapter test only: "3 de 6". */
    position: z.object({ index: z.int().min(1), total: z.int().min(1) }).nullable(),
  }),
]);
export type TrailStep = z.infer<typeof TrailStepSchema>;

export const TrailConceptStateSchema = z.enum(['cleared', 'shaky', 'current', 'upcoming']);

export const TrailChapterViewSchema = z.object({
  topic_id: UuidSchema,
  /** The unit the topic belongs to (Chefão), null for a topic at the root. */
  unit_id: UuidSchema.nullable(),
  title: z.string(),
  why: z.string().nullable(),
  status: z.enum(['done', 'current', 'upcoming']),
  concepts: z.array(z.object({ id: UuidSchema, title: z.string(), state: TrailConceptStateSchema })),
});
export type TrailChapterView = z.infer<typeof TrailChapterViewSchema>;

export const TrailStateSchema = z.object({
  trail_id: UuidSchema,
  subject_id: UuidSchema,
  status: z.enum(TRAIL_STATUS),
  goal: z.string().nullable(),
  /** Whole path, 0–1. */
  progress: z.number().min(0).max(1),
  chapter_index: z.int().min(0),
  chapters: z.array(TrailChapterViewSchema),
  /** `teach`: the chapter test is passed and Ensine o Lucas on the topic closes the chapter (TRL-01.12). */
  phase: z.enum(['learning', 'checkpoint', 'teach', 'completed']),
  checkpoint: z.object({ round: z.int().min(1), answered: z.int().min(0), total: z.int().min(0), correct: z.int().min(0) }).nullable(),
  /** The step to show now, or null while its content is being prepared (or the path is complete). */
  step: TrailStepSchema.nullable(),
  /** On a lesson: the step that follows once it is read, when it is already written. The app shows it at once and sends the lesson's answer behind it. */
  next_step: TrailStepSchema.nullable(),
  teach: z
    .object({ topic_id: UuidSchema, title: z.string(), pass_score: z.int().min(0).max(100), best_score: z.int().min(0).max(100).nullable(), attempts: z.int().min(0) })
    .nullable(),
  /** A unit whose chapters are all done and whose Chefão is not defeated yet (TRL-01.14). */
  boss: z.object({ unit_id: UuidSchema, title: z.string() }).nullable(),
  /** Set when this request finished a chapter. */
  chapter_done: z.object({ topic_id: UuidSchema, title: z.string(), next_title: z.string().nullable() }).nullable(),
  /** The next step needs content: call trail-prepare and show "Preparando…". */
  preparing: z.boolean(),
  /** The buffer can be topped up: call trail-prepare in the background. */
  prefetch: z.boolean(),
});
export type TrailState = z.infer<typeof TrailStateSchema>;

export const TrailOpenReqSchema = z.object({ subject_id: UuidSchema });
export type TrailOpenReq = z.infer<typeof TrailOpenReqSchema>;

export const TrailPrepareReqSchema = z.object({ trail_id: UuidSchema });
export type TrailPrepareReq = z.infer<typeof TrailPrepareReqSchema>;

export const TrailAnswerReqSchema = z.object({
  trail_id: UuidSchema,
  step_id: UuidSchema,
  /** Option id for a question; null to mark a lesson as read. */
  response: z.enum(['A', 'B', 'C', 'D']).nullable(),
  time_spent_ms: z.int().min(0).max(3_600_000).optional(),
});
export type TrailAnswerReq = z.infer<typeof TrailAnswerReqSchema>;

export const TrailFeedbackSchema = z.object({
  correct: z.boolean(),
  correct_option: z.string(),
  explanation: z.string(),
  tip: z.string().nullable(),
  rationales: z.array(z.object({ id: z.string(), text: z.string(), rationale: z.string() })),
});
export type TrailFeedback = z.infer<typeof TrailFeedbackSchema>;

export const TrailAnswerResSchema = z.object({
  /** Questions only. */
  feedback: TrailFeedbackSchema.nullable(),
  /** Set when this answer closed a chapter-test round. */
  checkpoint_result: z.object({ round: z.int().min(1), correct: z.int().min(0), total: z.int().min(1), passed: z.boolean() }).nullable(),
  /** A missed question saved to the Caderno de Erros (TRL-01.13). */
  mistake_id: UuidSchema.nullable(),
  state: TrailStateSchema,
});
export type TrailAnswerRes = z.infer<typeof TrailAnswerResSchema>;

/**
 * trail-grade: the verdict of a question, as soon as it is recorded (same input as trail-answer). The explanation,
 * the tip and the next state come from trail-settle.
 */
export const TrailGradeResSchema = z.object({
  correct: z.boolean(),
  correct_option: z.string(),
});
export type TrailGradeRes = z.infer<typeof TrailGradeResSchema>;

/** trail-settle: what a graded question leaves behind (mastery, the Caderno, the chapter). Returns a TrailAnswerRes. */
export const TrailSettleReqSchema = z.object({
  trail_id: UuidSchema,
  step_id: UuidSchema,
  time_spent_ms: z.int().min(0).max(3_600_000).optional(),
});
export type TrailSettleReq = z.infer<typeof TrailSettleReqSchema>;
