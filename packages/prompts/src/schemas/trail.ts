import { z } from 'zod';
import { ConceptKey, DocPageRef } from './common.ts';

// ---------------------------------------------------------------------------
// TRL-01 — Trilha (spec 14 §7): the path order, lessons, re-teaching and chapter tests
// ---------------------------------------------------------------------------

const TrailTopicKey = z.string().regex(/^T\d{1,3}$/, 'chave de tópico T1, T2…').meta({ 'x-choice': 'topic' });

/** trail.plan output. The server repairs it against prerequisites (normalizeTrailPlan), so it never has to be perfect. */
export const TrailPlan = z.strictObject({
  goal: z.string().min(1).max(240),
  chapters: z
    .array(
      z.strictObject({
        topic_key: TrailTopicKey,
        why: z.string().min(1).max(140),
        concept_keys: z.array(ConceptKey).max(20),
      }),
    )
    .min(1)
    .max(80),
});

/** A key term the app underlines in the text and defines on tap. */
export const TrailTerm = z.strictObject({
  term: z.string().min(1).max(60),
  definition: z.string().min(1).max(160),
});

export const TrailLessonBody = z.strictObject({
  title: z.string().min(1).max(80),
  body: z.string().min(1).max(1400),
  terms: z.array(TrailTerm).max(6),
  source_pages: z.array(DocPageRef).min(1).max(6),
});

const TrailOptionId = z.enum(['A', 'B', 'C', 'D']);

const TrailQuestionBase = z.strictObject({
  stem: z.string().min(1).max(320),
  options: z
    .array(z.strictObject({ id: TrailOptionId, text: z.string().min(1).max(180), rationale: z.string().min(1).max(220) }))
    .length(4),
  correct: TrailOptionId,
  explanation: z.string().min(1).max(500),
  tip: z.string().min(1).max(160).nullable(),
  terms: z.array(TrailTerm).max(4),
  source_pages: z.array(DocPageRef).min(1).max(6),
});

function questionIssues(v: z.infer<typeof TrailQuestionBase>, ctx: z.RefinementCtx, path: (string | number)[] = []) {
  const ids = v.options.map((o) => o.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'alternativas repetidas', path: [...path, 'options'] });
  if (!ids.includes(v.correct)) ctx.addIssue({ code: 'custom', message: 'correct fora das alternativas', path: [...path, 'correct'] });
}

export const TrailQuestion = TrailQuestionBase.superRefine((v, ctx) => questionIssues(v, ctx));

/** trail.lesson output: one concept's lesson and its three questions (two asked, one spare). */
export const TrailLesson = z.strictObject({
  lesson: TrailLessonBody,
  questions: z.array(TrailQuestion).length(3),
});

/**
 * trail.reinforce output: what a concept's lesson needs after it, written ahead with the lesson (ADR 0011) — a
 * re-explanation from another angle with fresh questions for after a miss, and test-level questions for the chapter
 * test. Shared by every student of the subject.
 */
export const TrailReinforcement = z.strictObject({
  lesson: TrailLessonBody,
  remedial_questions: z.array(TrailQuestion).length(3),
  test_questions: z.array(TrailQuestion).length(4),
});

/** trail.remediate output: a re-explanation aimed at the mistake and a fresh question on the same point. */
export const TrailRemediation = z.strictObject({
  lesson: TrailLessonBody,
  question: TrailQuestion,
});

/** trail.checkpoint output: the chapter test, each question tagged with the concept it checks. */
export const TrailCheckpoint = z.strictObject({
  questions: z
    .array(
      TrailQuestionBase.extend({ concept_key: ConceptKey }).superRefine((v, ctx) => questionIssues(v, ctx)),
    )
    .min(1)
    .max(10),
});
