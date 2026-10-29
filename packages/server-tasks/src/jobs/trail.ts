// Trilha content written ahead (TRL-01, ADR 0011): the subject's path order and each topic's concept content. Both
// start in the background — after a topic's content is written, after the prerequisites of a material, and when a
// student opens a subject whose content predates them — and only write what is still missing.
import { z } from 'zod';
import type { OperationDefinition } from '../framework/types.ts';
import { parsePayload } from '../framework/errors.ts';
import { planSubject, prepareTopicContent } from '../lib/trail-content.ts';

const uuid = z.uuid();
const optionalUuid = uuid.nullable().default(null);

const TopicPayload = z.object({ topic_id: uuid, user_id: optionalUuid });
const SubjectPayload = z.object({ subject_id: uuid, user_id: optionalUuid });

export const jobs: OperationDefinition<any>[] = [
  {
    name: 'trail.prepare_topic',
    // Side work of a material: never a row of its own in the student's progress list.
    tracksProgress: false,
    // Each run makes a few calls at once; a material's topics queue on the calendar behind these.
    concurrency: 4,
    handler: async (ctx, data) => {
      const p = parsePayload(TopicPayload, data, 'trail.prepare_topic');
      await prepareTopicContent(ctx, { topicId: p.topic_id, userId: p.user_id });
    },
  },
  {
    name: 'trail.plan_subject',
    tracksProgress: false,
    handler: async (ctx, data) => {
      const p = parsePayload(SubjectPayload, data, 'trail.plan_subject');
      const outcome = await planSubject(ctx, { subjectId: p.subject_id, userId: p.user_id });
      ctx.log.info({ subjectId: p.subject_id, outcome }, 'trail plan');
    },
  },
];
