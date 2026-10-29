// admin-overview (web dashboard, Administração → Visão geral; api.md §4.11, PLT-04.6). People, AI spend against
// the global cap with the 80%/100% and 5×-median alerts, the moderation queue and operations, in one read.
import { defineFunction } from '../shared/http.ts';
import { requireAppAdmin } from '../shared/access.ts';
import pkg from '../../package.json' with { type: 'json' };

const STARTED_AT = new Date().toISOString();

export const handler = defineFunction<undefined>({
  name: 'admin-overview',
  mutating: false,
  run: async (ctx) => {
    const { db } = ctx.deps;
    await requireAppAdmin(db, ctx.user.userId);
    const { data, error } = await db.schema('private').rpc('admin_overview');
    if (error) throw error;
    return ctx.json({ ...(data as Record<string, unknown>), server: { version: pkg.version, started_at: STARTED_AT } });
  },
});

export default handler;
