// admin-users (web dashboard, Administração → Usuários; api.md §4.11). Search by name, e-mail or id, with filters
// (admins, names to review, suspended, minors, deletion requested), newest first, paged.
import { AdminUsersReqSchema, type AdminUsersReq } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { requireAppAdmin } from '../shared/access.ts';

export const handler = defineFunction<AdminUsersReq>({
  name: 'admin-users',
  mutating: false,
  input: AdminUsersReqSchema,
  run: async (ctx) => {
    const { db } = ctx.deps;
    await requireAppAdmin(db, ctx.user.userId);
    const { query, filter, limit, offset } = ctx.input;
    const { data, error } = await db.schema('private').rpc('admin_users', {
      p_query: query?.trim() || null,
      p_filter: filter,
      p_limit: limit,
      p_offset: offset,
    });
    if (error) throw error;
    return ctx.json(data);
  },
});

export default handler;
