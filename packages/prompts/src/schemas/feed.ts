import { z } from 'zod';
import { ConceptKey, DocPageRef } from './common.ts';

const QuickQuestion = z.strictObject({
  stem: z.string().min(1).max(200),
  options: z
    .array(z.strictObject({ id: z.string().regex(/^[A-D]$/), text: z.string().min(1).max(120), rationale: z.string().min(1).max(140) }))
    .min(2) // Verdadeiro/Falso as A/B (spec 06 FED-01.2)
    .max(4),
  correct: z.string().regex(/^[A-D]$/),
});

const FeedItemBase = z.strictObject({
  type: z.enum(['micro_lesson', 'quick_question', 'diagram', 'did_you_know']),
  concept_key: ConceptKey.nullable(),
  title: z.string().min(1).max(80),
  body: z.string().min(1).max(280),
  formula_latex: z.string().min(1).max(200).nullable(),
  question: QuickQuestion.nullable(),
  figure_page: z.number().int().min(1).nullable(),
  caption: z.string().min(1).max(160).nullable(),
  external_knowledge: z.boolean(),
  source_pages: z.array(DocPageRef).min(1).max(6),
});

/** FED-01.2 items. Type-specific requirements are checked here, not left to the prompt. */
export const FeedItem = FeedItemBase.superRefine((v, ctx) => {
  if (v.type === 'quick_question' && !v.question) {
    ctx.addIssue({ code: 'custom', message: 'quick_question sem question', path: ['question'] });
  }
  if (v.type === 'diagram' && v.figure_page === null) {
    ctx.addIssue({ code: 'custom', message: 'diagram sem figure_page', path: ['figure_page'] });
  }
  if (v.type !== 'quick_question' && v.type !== 'diagram' && v.question !== null) {
    ctx.addIssue({ code: 'custom', message: 'question só em quick_question ou diagram', path: ['question'] });
  }
  if (v.question && !v.question.options.some((o) => o.id === v.question?.correct)) {
    ctx.addIssue({ code: 'custom', message: 'correct fora das alternativas', path: ['question', 'correct'] });
  }
});

// Spec 06 §7 targets 3 items per concept (1 micro_lesson + 2 quick_question), 1–2 did_you_know and up to 3
// diagrams per topic: 50 covers a topic at the 15-concept cap of TopicConcepts.
export const FeedItems = z.strictObject({
  items: z.array(FeedItem).min(1).max(50),
});
