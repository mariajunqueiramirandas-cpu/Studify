// account-membership (web dashboard, Minha conta; api.md §4.11). Leaves a Turma through leave_class_group (run as
// the student, so the owner rule and the member guard apply), or changes the member's own choices in it: weekly
// league, duels and anonymous class insights (SOC-08.1, SOC-02.12, SOC-04.6).
import { AccountMembershipReqSchema, ApiFailure, type AccountMembershipReq } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { loadAccountOverview } from '../shared/dashboard.ts';

export const handler = defineFunction<AccountMembershipReq>({
  name: 'account-membership',
  mutating: true,
  input: AccountMembershipReqSchema,
  run: async (ctx) => {
    const { db } = ctx.deps;
    const input = ctx.input;
    const userId = ctx.user.userId;

    if (input.action === 'leave') {
      const { error } = await ctx.deps.asUser(ctx.user).rpc('leave_class_group', { p_class_group_id: input.class_group_id });
      if (error) {
        if (error.message === 'owner_must_transfer') {
          throw new ApiFailure('forbidden', { message: 'Você é dono(a) dessa turma. Passe a turma pra outra pessoa no app antes de sair.' });
        }
        if (error.message === 'not_member') throw new ApiFailure('not_found');
        throw error;
      }
      return ctx.json(await loadAccountOverview(ctx.deps, ctx.user, ctx.now));
    }

    const patch: Record<string, boolean> = {};
    if (input.league_opt_in !== undefined) patch.league_opt_in = input.league_opt_in;
    if (input.accepts_duels !== undefined) patch.accepts_duels = input.accepts_duels;
    if (input.contribute_insights !== undefined) patch.contribute_insights = input.contribute_insights;
    if (Object.keys(patch).length === 0) throw new ApiFailure('invalid_request', { message: 'Nada pra mudar.' });
    const res = await db
      .from('class_group_members')
      .update(patch)
      .eq('class_group_id', input.class_group_id)
      .eq('user_id', userId)
      .eq('status', 'active')
      .select('class_group_id');
    if (res.error) throw res.error;
    if (((res.data as unknown[] | null) ?? []).length === 0) throw new ApiFailure('not_found');
    return ctx.json(await loadAccountOverview(ctx.deps, ctx.user, ctx.now));
  },
});

export default handler;
