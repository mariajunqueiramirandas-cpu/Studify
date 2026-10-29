// admin-moderation (web dashboard, Administração → Moderação; api.md §4.11, SP-09, TRU-02). The operator's queue:
// open and escalated reports, flagged content with the AI triage, display names to review and app feedback.
import { defineFunction } from '../shared/http.ts';
import { requireAppAdmin } from '../shared/access.ts';

export const handler = defineFunction<undefined>({
  name: 'admin-moderation',
  mutating: false,
  run: async (ctx) => {
    const { db } = ctx.deps;
    await requireAppAdmin(db, ctx.user.userId);
    const { data, error } = await db.schema('private').rpc('admin_moderation');
    if (error) throw error;
    return ctx.json(data);
  },
});

export default handler;
