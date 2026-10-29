// admin-ai-usage (web dashboard, Administração → Uso de IA; api.md §4.11, ai-pipeline §11). Cost per day, feature,
// task, model and Turma, the heaviest users, refusals, fallbacks, cache reads and latency for the last N days.
import { AdminAiUsageReqSchema } from '@studify/shared';
import type { z } from 'zod';
import { defineFunction } from '../shared/http.ts';
import { requireAppAdmin } from '../shared/access.ts';

export const handler = defineFunction<z.infer<typeof AdminAiUsageReqSchema>>({
  name: 'admin-ai-usage',
  mutating: false,
  input: AdminAiUsageReqSchema,
  run: async (ctx) => {
    const { db } = ctx.deps;
    await requireAppAdmin(db, ctx.user.userId);
    const { data, error } = await db.schema('private').rpc('admin_ai_report', { p_days: ctx.input.days });
    if (error) throw error;
    return ctx.json(data);
  },
});

export default handler;
