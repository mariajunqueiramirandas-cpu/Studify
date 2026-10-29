// account-overview (web dashboard, Minha conta; api.md §4.11). Everything the account pages show in one read:
// profile, preferences, quiet hours, AI usage as percentages, activity, Turmas, devices, exports and deletion.
import { defineFunction } from '../shared/http.ts';
import { loadAccountOverview } from '../shared/dashboard.ts';

export const handler = defineFunction<undefined>({
  name: 'account-overview',
  mutating: false,
  run: async (ctx) => ctx.json(await loadAccountOverview(ctx.deps, ctx.user, ctx.now)),
});

export default handler;
