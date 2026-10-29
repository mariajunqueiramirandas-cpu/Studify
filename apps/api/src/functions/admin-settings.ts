// admin-settings (web dashboard, Administração → Configurações and Convites; api.md §4.11). AI limits (PLT-04.6),
// feature flags (PLT-01.6), app versions and the minimum one (PLT-06.3), and pilot invites (SP-02).
import { defineP2 } from '../shared-p2/http.ts';
import { requireAppAdmin } from '../shared/access.ts';
import { loadAdminSettings } from '../shared/dashboard.ts';

export const handler = defineP2<undefined>({
  name: 'admin-settings',
  mutating: false,
  run: async (ctx) => {
    await requireAppAdmin(ctx.deps.db, ctx.user.userId);
    return ctx.json(await loadAdminSettings(ctx.deps.db, ctx.p2.baseUrl));
  },
});

export default handler;
