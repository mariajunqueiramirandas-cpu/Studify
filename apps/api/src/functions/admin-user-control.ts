// admin-user-control (web dashboard, Administração → Usuários; api.md §4.11). The owner's actions on one account:
// role, display-name review (SP-11), suspension (SP-09, security-privacy §9) and the student's own daily AI limit
// (PLT-04.6). Every action is written to the audit log; suspensions also to private.moderation_actions.
// Guards: nobody removes their own admin role (there is always an owner left) or suspends themselves, and an
// admin must lose the role before they can be suspended.
import type { Db } from '@studify/db';
import { AdminUserControlReqSchema, ApiFailure, type AdminUserControlReq } from '@studify/shared';
import { forgetUser } from '../shared/auth.ts';
import { defineFunction } from '../shared/http.ts';
import { requireAppAdmin } from '../shared/access.ts';
import { audit, loadAdminUserDetail } from '../shared/dashboard.ts';

/** GoTrue ban length for "until lifted": 100 years. */
const INDEFINITE_BAN = '876000h';

/** The moderation record kept for 5 years (security-privacy §12). Logged on failure: the ban is already in place. */
async function recordModeration(db: Db, row: { actor_id: string; action: 'ban' | 'unban'; target_id: string; reason: string | null }): Promise<void> {
  const { error } = await db.schema('private').from('moderation_actions').insert({ ...row, actor_kind: 'app_admin', target_type: 'profile' });
  if (error) console.error('moderation_actions insert failed', row.action, error.message);
}

export const handler = defineFunction<AdminUserControlReq>({
  name: 'admin-user-control',
  mutating: true,
  input: AdminUserControlReqSchema,
  run: async (ctx) => {
    const { db } = ctx.deps;
    const input = ctx.input;
    const actor = ctx.user.userId;
    await requireAppAdmin(db, actor);

    const target = await db.from('profiles').select('id, app_role, display_name').eq('id', input.user_id).maybeSingle();
    if (target.error) throw target.error;
    if (!target.data) throw new ApiFailure('not_found');
    const role = target.data.app_role as string;
    const self = input.user_id === actor;

    switch (input.action) {
      case 'set_role': {
        if (self && input.role !== 'app_admin') {
          throw new ApiFailure('forbidden', { message: 'Você não pode tirar o seu próprio acesso de admin. Peça pra outra pessoa admin.' });
        }
        if (role !== input.role) {
          const res = await db.from('profiles').update({ app_role: input.role }).eq('id', input.user_id);
          if (res.error) throw res.error;
          await audit(db, actor, 'user.set_role', 'profile', input.user_id, { from: role, to: input.role });
        }
        break;
      }
      case 'approve_name':
      case 'reject_name': {
        const status = input.action === 'approve_name' ? 'approved' : 'rejected';
        const res = await db.from('profiles').update({ display_name_status: status }).eq('id', input.user_id);
        if (res.error) throw res.error;
        await audit(db, actor, `user.${input.action}`, 'profile', input.user_id, { display_name: target.data.display_name });
        break;
      }
      case 'suspend': {
        if (self) throw new ApiFailure('forbidden', { message: 'Você não pode suspender a sua própria conta.' });
        if (role === 'app_admin') throw new ApiFailure('forbidden', { message: 'Tire o acesso de admin antes de suspender essa conta.' });
        const { error } = await db.auth.admin.updateUserById(input.user_id, { ban_duration: input.days ? `${input.days * 24}h` : INDEFINITE_BAN });
        if (error) throw error;
        // Tokens this API remembered as verified are checked again on the next call, and refused.
        forgetUser(db, input.user_id);
        await recordModeration(db, { actor_id: actor, action: 'ban', target_id: input.user_id, reason: input.reason });
        await audit(db, actor, 'user.suspend', 'profile', input.user_id, { days: input.days, reason: input.reason });
        break;
      }
      case 'unsuspend': {
        const { error } = await db.auth.admin.updateUserById(input.user_id, { ban_duration: 'none' });
        if (error) throw error;
        await recordModeration(db, { actor_id: actor, action: 'unban', target_id: input.user_id, reason: null });
        await audit(db, actor, 'user.unsuspend', 'profile', input.user_id);
        break;
      }
      case 'set_daily_limit': {
        const { error } = await db.schema('private').rpc('ai_budget_set_limit', {
          p_scope_type: 'user', p_scope_id: input.user_id, p_limit: input.limit_micro_usd, p_actor: actor,
        });
        if (error) throw error;
        await audit(db, actor, 'user.set_daily_limit', 'profile', input.user_id, { limit_micro_usd: input.limit_micro_usd });
        break;
      }
    }
    return ctx.json(await loadAdminUserDetail(db, input.user_id));
  },
});

export default handler;
