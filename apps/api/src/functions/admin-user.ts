// admin-user (web dashboard, Administração → Usuários → one student; api.md §4.11). Profile, sign-in, Turmas,
// devices, AI spend and limit, activity, operations, reports, exports, deletion and the audit entries about them.
// Study content (notes, answers, tutor messages) is not part of it.
import { AdminUserReqSchema } from '@studify/shared';
import type { z } from 'zod';
import { defineFunction } from '../shared/http.ts';
import { requireAppAdmin } from '../shared/access.ts';
import { loadAdminUserDetail } from '../shared/dashboard.ts';

export const handler = defineFunction<z.infer<typeof AdminUserReqSchema>>({
  name: 'admin-user',
  mutating: false,
  input: AdminUserReqSchema,
  run: async (ctx) => {
    await requireAppAdmin(ctx.deps.db, ctx.user.userId);
    return ctx.json(await loadAdminUserDetail(ctx.deps.db, ctx.input.user_id));
  },
});

export default handler;
