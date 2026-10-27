// divide-merge (SOC-06.4; class C). The creator or a moderator closes the divisão early: the approved summaries
// so far are merged into the Resumo da turma by the worker (divide.merge). Topics without one keep their notes.
import { ApiFailure, DivideMergeReqSchema } from '@studify/shared';
import type { z } from 'zod';
import { defineFunction } from '../shared/http.ts';
import { startMerge, type DividePlanRow } from '../shared-p5/divide.ts';

export const handler = defineFunction<z.infer<typeof DivideMergeReqSchema>>({
  name: 'divide-merge',
  mutating: true,
  input: DivideMergeReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    const p = await deps.db.from('divide_plans').select('id, class_group_id, subject_id, node_ids, assignments, status, created_by').eq('id', input.divide_plan_id).maybeSingle();
    if (p.error) throw p.error;
    if (!p.data) throw new ApiFailure('not_found');
    const plan = p.data as DividePlanRow;
    const member = await deps.db.from('class_group_members').select('role, status').eq('class_group_id', plan.class_group_id).eq('user_id', userId).maybeSingle();
    if (member.error) throw member.error;
    if (member.data?.status !== 'active') throw new ApiFailure('not_found');
    const moderator = member.data.role === 'owner' || member.data.role === 'moderator';
    if (plan.created_by !== userId && !moderator) throw new ApiFailure('forbidden', { message: 'Só quem criou a divisão ou a moderação pode fechar.' });
    if (plan.status === 'merging' || plan.status === 'done') return ctx.json({ job_id: null, status: plan.status });
    if (plan.status !== 'open') throw new ApiFailure('already_completed');
    const approved = await deps.db.from('contributions').select('id', { count: 'exact', head: true }).eq('divide_plan_id', plan.id).eq('status', 'approved');
    if (approved.error) throw approved.error;
    if (!approved.count) throw new ApiFailure('invalid_request', { message: 'Ainda não tem nenhum resumo enviado pra juntar.' });
    const jobId = await startMerge(deps, plan);
    return ctx.json({ job_id: jobId, status: 'merging' }, 202);
  },
});

export default handler;
