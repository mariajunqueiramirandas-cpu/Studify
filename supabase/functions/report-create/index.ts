// report-create (SP-09, SOC). Reports a person, a Turma item or content. A report about a Turma needs an
// active membership. The notification to moderators is queued (notify.dispatch); the worker resolves them.
import { z } from 'zod';
import { ApiFailure, ReportCreateReqSchema, } from '@studify/shared';
import type { ReportCreateRes } from '../_shared/responses.ts';
import { defineFunction } from '../_shared/http.ts';
import { activeMembership } from '../_shared/access.ts';

type Req = z.infer<typeof ReportCreateReqSchema>;

export const handler = defineFunction<Req>({
  name: 'report-create',
  mutating: true,
  input: ReportCreateReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    if (input.class_group_id && !(await activeMembership(deps.db, userId, input.class_group_id))) {
      throw new ApiFailure('not_member');
    }
    if (input.reported_id === userId) throw new ApiFailure('invalid_request', { message: 'Não dá pra denunciar a si mesmo.' });

    const reportId = deps.newId();
    const inserted = await deps.db.from('user_reports').insert({
      id: reportId,
      reporter_id: userId,
      reported_id: input.reported_id ?? null,
      class_group_id: input.class_group_id ?? null,
      reason: input.reason,
      context_type: input.context_type ?? null,
      context_id: input.context_id ?? null,
      comment: input.comment ?? null,
      status: 'open',
    });
    if (inserted.error) throw inserted.error;
    await deps.enqueue('notify.dispatch', {
      user_id: null,
      type: 'report_created',
      data: { report_id: reportId, class_group_id: input.class_group_id ?? null },
    }, { retryLimit: 3 });

    const body: ReportCreateRes = { report_id: reportId };
    return ctx.json(body);
  },
});

export default handler;

// Entry point: serves the function when this file is the main module. Tests import `handler` only.
if (import.meta.main) {
  const { prodDeps } = await import('../_shared/prod.ts');
  Deno.serve((req) => handler(req, prodDeps()));
}
