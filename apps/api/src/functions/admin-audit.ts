// admin-audit (web dashboard, Administração → Registro; api.md §4.11, security-privacy §12). The audit log,
// newest first, paged back with `before`.
import { AdminAuditReqSchema } from '@studify/shared';
import type { z } from 'zod';
import { defineFunction } from '../shared/http.ts';
import { requireAppAdmin } from '../shared/access.ts';

export const handler = defineFunction<z.infer<typeof AdminAuditReqSchema>>({
  name: 'admin-audit',
  mutating: false,
  input: AdminAuditReqSchema,
  run: async (ctx) => {
    const { db } = ctx.deps;
    await requireAppAdmin(db, ctx.user.userId);
    const { data, error } = await db.schema('private').rpc('admin_audit_list', {
      p_limit: ctx.input.limit,
      p_before: ctx.input.before ?? null,
      p_target: null,
    });
    if (error) throw error;
    return ctx.json({ entries: data ?? [] });
  },
});

export default handler;
