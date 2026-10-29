// report-create (SP-09, SOC). Reports a person, a Turma item or content. A report about a Turma needs an
// active membership. The notification to moderators is queued (notify.dispatch); the worker resolves them.
import { z } from 'zod';
import { ApiFailure, ReportCreateReqSchema, } from '@studify/shared';
import type { ReportCreateRes } from '../shared/responses.ts';
import { defineFunction } from '../shared/http.ts';
import { activeMembership } from '../shared/access.ts';
import { inBackground, type Deps } from '../shared/deps.ts';

type Req = z.infer<typeof ReportCreateReqSchema>;

/**
 * Who is told about a report, other than the reporter: the owner and moderators of the Turma the report is about
 * (class_group_members, role owner|moderator, active). A report with no Turma goes to the app admins, the Studify
 * operator who escalates it (SP-09, profiles.app_role).
 */
async function reportRecipients(db: Deps['db'], classGroupId: string | null, reporterId: string): Promise<string[]> {
  if (classGroupId) {
    const { data, error } = await db
      .from('class_group_members')
      .select('user_id')
      .eq('class_group_id', classGroupId)
      .eq('status', 'active')
      .in('role', ['owner', 'moderator']);
    if (error) throw error;
    return (data as Array<{ user_id: string }>).map((row) => row.user_id).filter((id) => id !== reporterId);
  }
  const { data, error } = await db.from('profiles').select('id').eq('app_role', 'app_admin');
  if (error) throw error;
  return (data as Array<{ id: string }>).map((row) => row.id).filter((id) => id !== reporterId);
}

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
    // One notification per recipient: notify.dispatch needs a user (the worker pushes to a user's devices).
    const recipients = await reportRecipients(deps.db, input.class_group_id ?? null, userId);
    await Promise.all(recipients.map((recipient) => inBackground(deps, 'notify.dispatch', {
      user_id: recipient,
      type: 'report_created',
      data: { report_id: reportId, class_group_id: input.class_group_id ?? null },
    }, `report_created:${reportId}:${recipient}`)));

    const body: ReportCreateRes = { report_id: reportId };
    return ctx.json(body);
  },
});

export default handler;
