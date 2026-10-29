// admin-moderation-control (web dashboard, Administração → Moderação; api.md §4.11, SP-09, TRU-02). Closes a report
// (actioned / dismissed) or escalates it, or resolves a content flag through resolve_flag, run as the admin so the
// function's own checks, fixes and moderation record apply. Answers the fresh queue.
import { AdminModerationControlReqSchema, ApiFailure, type AdminModerationControlReq } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { requireAppAdmin } from '../shared/access.ts';
import { audit } from '../shared/dashboard.ts';

const OPEN_REPORT = ['open', 'escalated'];
const OPEN_FLAG = ['open', 'triaged', 'hidden_pending'];

export const handler = defineFunction<AdminModerationControlReq>({
  name: 'admin-moderation-control',
  mutating: true,
  input: AdminModerationControlReqSchema,
  run: async (ctx) => {
    const { db } = ctx.deps;
    const input = ctx.input;
    const actor = ctx.user.userId;
    await requireAppAdmin(db, actor);

    if (input.action === 'report') {
      const report = await db.from('user_reports').select('id, status').eq('id', input.report_id).maybeSingle();
      if (report.error) throw report.error;
      if (!report.data) throw new ApiFailure('not_found');
      if (!OPEN_REPORT.includes(report.data.status as string)) throw new ApiFailure('already_completed', { message: 'Essa denúncia já foi resolvida.' });
      const res = await db
        .from('user_reports')
        .update({ status: input.decision, handled_by: actor, handled_at: ctx.now.toISOString() })
        .eq('id', input.report_id);
      if (res.error) throw res.error;
      await audit(db, actor, `report.${input.decision}`, 'user_report', input.report_id, input.note ? { note: input.note } : {});
    } else {
      const flag = await db.from('content_flags').select('id, status, item_type, item_id').eq('id', input.flag_id).maybeSingle();
      if (flag.error) throw flag.error;
      if (!flag.data) throw new ApiFailure('not_found');
      if (!OPEN_FLAG.includes(flag.data.status as string)) throw new ApiFailure('already_completed', { message: 'Essa sinalização já foi resolvida.' });
      const { error } = await ctx.deps.asUser(ctx.user.jwt).rpc('resolve_flag', { p_flag_id: input.flag_id, p_decision: input.decision });
      if (error) throw error;
      await audit(db, actor, `flag.${input.decision}`, 'content_flag', input.flag_id, { item_type: flag.data.item_type, item_id: flag.data.item_id });
    }

    const { data, error } = await db.schema('private').rpc('admin_moderation');
    if (error) throw error;
    return ctx.json(data);
  },
});

export default handler;
