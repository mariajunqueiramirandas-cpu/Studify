// admin-class-groups (web dashboard, Administração → Turmas; api.md §4.11, PLT-04.5). Every live Turma with its
// owner, members, this month's AI spend and the monthly limit that applies.
import { defineFunction } from '../shared/http.ts';
import { requireAppAdmin } from '../shared/access.ts';
import type { AdminClassGroups } from '@studify/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function loadAdminClassGroups(db: SupabaseClient): Promise<AdminClassGroups> {
  const [groups, limits] = await Promise.all([db.schema('private').rpc('admin_class_groups'), db.schema('private').rpc('admin_limits')]);
  if (groups.error) throw groups.error;
  if (limits.error) throw limits.error;
  return {
    class_groups: (groups.data as AdminClassGroups['class_groups'] | null) ?? [],
    default_limit: Number((limits.data as { class_group_month: { effective: number } }).class_group_month.effective),
  };
}

export const handler = defineFunction<undefined>({
  name: 'admin-class-groups',
  mutating: false,
  run: async (ctx) => {
    await requireAppAdmin(ctx.deps.db, ctx.user.userId);
    return ctx.json(await loadAdminClassGroups(ctx.deps.db));
  },
});

export default handler;
