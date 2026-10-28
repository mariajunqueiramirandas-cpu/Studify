import { z } from 'zod';
import { NodeKey, DocPageRef } from './common.ts';

/** GOL-07.2 / vespera.cheatsheet output. Sources must come from pages cited by the input notes. */
export const Cheatsheet = z.strictObject({
  title: z.string().min(1).max(80),
  sections: z
    .array(
      z.strictObject({
        node_key: NodeKey,
        heading: z.string().min(1).max(80),
        bullets: z
          .array(z.strictObject({ text: z.string().min(1).max(200), source_pages: z.array(DocPageRef).min(1).max(4) }))
          .min(1)
          .max(6),
        formula: z.string().min(1).max(200).nullable(),
      }),
    )
    .min(1)
    .max(10),
  watch_out: z
    .array(z.strictObject({ text: z.string().min(1).max(200), from_mistake_id: z.string().min(1).max(64).nullable() }))
    .max(6),
});

// ---------------------------------------------------------------------------
// GOL-04.10 — plan.coach: strategy, topic priorities and next steps until the tests
// ---------------------------------------------------------------------------

const ExamKey = z.string().regex(/^E\d{1,2}$/, 'chave de prova E1, E2…');
const TopicKey = z.string().regex(/^T\d{1,3}$/, 'chave de tópico T1, T2…');

/** plan.coach output. Priorities become planner topic weights; the texts are shown on Hoje and on plan items. */
export const PlanCoach = z.strictObject({
  headline: z.string().min(1).max(120),
  exams: z
    .array(
      z.strictObject({
        exam_key: ExamKey,
        strategy: z.string().min(1).max(320),
        risk: z.enum(['low', 'medium', 'high']),
      }),
    )
    .max(10),
  topics: z
    .array(
      z.strictObject({
        topic_key: TopicKey,
        priority: z.number().min(0).max(1),
        approach: z.enum(['learn', 'practice', 'review', 'maintain']),
        focus: z.string().min(1).max(140),
        why: z.string().min(1).max(140),
      }),
    )
    .max(60),
  next_steps: z
    .array(
      z.strictObject({
        when: z.enum(['today', 'tomorrow', 'this_week', 'before_exam']),
        title: z.string().min(1).max(80),
        detail: z.string().min(1).max(180),
        topic_key: TopicKey.nullable(),
      }),
    )
    .min(1)
    .max(5),
  watch_out: z.string().min(1).max(200).nullable(),
});
