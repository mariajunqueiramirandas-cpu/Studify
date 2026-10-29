// admin-class-group-control (web dashboard, Administração → Turmas; api.md §4.11, PLT-04.6). Sets or clears one
// Turma's monthly AI limit; the open month picks it up at once (private.ai_budget_set_limit).
import { AdminClassGroupControlReqSchema, type AdminClassGroupControlReq } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { requireAppAdmin } from '../shared/access.ts';
import { audit } from '../shared/dashboard.ts';
import { loadAdminClassGroups } from './admin-class-groups.ts';

export const handler = defineFunction<AdminClassGroupControlReq>({
  name: 'admin-class-group-control',
  mutating: true,
  input: AdminClassGroupControlReqSchema,
  run: async (ctx) => {
    const { db } = ctx.deps;
    const input = ctx.input;
    await requireAppAdmin(db, ctx.user.userId);
    const { error } = await db.schema('private').rpc('ai_budget_set_limit', {
      p_scope_type: 'class_group', p_scope_id: input.class_group_id, p_limit: input.limit_micro_usd, p_actor: ctx.user.userId,
    });
    if (error) throw error;
    await audit(db, ctx.user.userId, 'class_group.set_budget', 'class_group', input.class_group_id, { limit_micro_usd: input.limit_micro_usd });
    return ctx.json(await loadAdminClassGroups(db));
  },
});

export default handler;
