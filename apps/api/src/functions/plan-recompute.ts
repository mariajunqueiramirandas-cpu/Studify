// plan-recompute (GOL-04, GOL-05, ENM-07). The planner (buildPlan) needs the full PlanInput, which a worker
// loads, so this endpoint queues plan.recompute instead of computing inline. Calls within 30 s for the same
// student coalesce into one job (pg-boss singleton). Response: 202 with job_id, or null when coalesced.
import { z } from 'zod';
import { ApiFailure, PlanRecomputeReqSchema } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';

type Req = z.infer<typeof PlanRecomputeReqSchema>;

export const handler = defineFunction<Req>({
  name: 'plan-recompute',
  mutating: true,
  input: PlanRecomputeReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    if (input.goal_id) {
      const goal = await deps.db.from('goals').select('id, user_id').eq('id', input.goal_id).is('deleted_at', null).maybeSingle();
      if (goal.error) throw goal.error;
      if (!goal.data || goal.data.user_id !== userId) throw new ApiFailure('not_found');
    }
    const jobId = await deps.enqueue(
      'plan.recompute',
      { user_id: userId, trigger: input.trigger, goal_id: input.goal_id ?? null, local_date: input.local_date ?? null },
      { singletonKey: userId, singletonSeconds: 30, retryLimit: 3 },
    );
    return ctx.json({ status: jobId ? 'queued' : 'coalesced', job_id: jobId }, 202);
  },
});

export default handler;
