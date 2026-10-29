// batch.poll (api.md §7, ai-pipeline §7.3): polls one Message Batch every 60 s until it ends, then collects the
// results by custom_id and routes them to the writers. The plan travels in the payload, so the job is
// stateless between polls and safe to retry.
import { z } from 'zod';
import type { OperationDefinition } from '../framework/types.ts';
import { parsePayload } from '../framework/errors.ts';
import { pollWave, type WavePlan } from '../ingest/waves.ts';
import { onWaveCollected } from '../ingest/pipeline.ts';
import { supabaseStore } from '../ingest/store.ts';

const uuid = z.uuid();

const PlanItemSchema = z.object({
  customId: z.string().min(1).max(64),
  kind: z.enum(['concepts', 'tldr', 'study', 'deep', 'glossary', 'cards', 'questions', 'feed', 'find_error', 'problems', 'transcription']),
  topicId: z.string().nullable(),
  taskId: z.string().min(1),
  promptVersion: z.string().min(1),
  blocks: z.array(z.object({ documentId: uuid, pages: z.array(z.number().int().min(1)).min(1).max(600) })).min(1).max(40),
  budget: z.object({
    userId: z.string().nullable(),
    classGroupId: z.string().nullable(),
    subjectId: z.string().nullable().optional(),
    documentId: z.string().nullable().optional(),
    nodeId: z.string().nullable().optional(),
    jobId: z.string().nullable().optional(),
    feature: z.string(),
    budgetClass: z.enum(['content', 'user', 'system']),
  }),
  language: z.string().min(2),
  genBatchId: z.string(),
  force: z.boolean(),
  pages: z.object({ start: z.number().int(), end: z.number().int() }).nullable(),
});

const PlanSchema = z.object({
  batchId: z.string().min(1),
  reservationId: z.string().min(1),
  estimateMicroUsd: z.number().nonnegative(),
  submittedAt: z.string().min(10),
  purpose: z.enum(['concepts', 'content', 'transcription']),
  aiJobId: z.string().nullable(),
  userId: z.string().nullable(),
  subjectId: uuid,
  documentId: z.string().nullable(),
  topicIds: z.array(z.string()).max(300),
  pollCount: z.number().int().min(0),
  items: z.array(PlanItemSchema).min(1).max(5000),
});

export const jobs: OperationDefinition<any>[] = [
  {
    name: 'batch.poll',
    handler: async (ctx, data, meta) => {
      const payload = parsePayload(z.object({ ai_job_id: z.string().nullable().optional(), plan: PlanSchema }), data, 'batch.poll');
      const plan = { ...(payload.plan as unknown as WavePlan), aiJobId: (payload.plan as { aiJobId: string | null }).aiJobId ?? payload.ai_job_id ?? meta.aiJobId };
      const store = supabaseStore(ctx.supabase);
      const env = (await import('../ingest/env.ts')).createEnv(ctx, store);
      const summary = await pollWave(env, plan);
      if (summary.done) {
        await onWaveCollected(ctx, store, plan, summary);
      }
    },
  },
];
