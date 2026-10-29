// Runs planning directly; concurrent requests for the same student share active work.
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
    const jobId = await deps.execute(
      'plan.recompute',
      { user_id: userId, trigger: input.trigger, goal_id: input.goal_id ?? null, local_date: input.local_date ?? null },
      { singletonKey: userId, },
    );
    return ctx.json({ status: jobId ? 'queued' : 'coalesced', job_id: jobId }, 202);
  },
});

export default handler;
