// account-export (SP-14, PLT-02.9). Queues a ZIP export; the worker writes it to the `exports` bucket and
// sends the export_ready push. At most one open export per student: a second request returns the open one.
import { defineFunction } from '../_shared/http.ts';

const OPEN = ['queued', 'running'];

export const handler = defineFunction<undefined>({
  name: 'account-export',
  mutating: true,
  run: async (ctx) => {
    const { db } = ctx.deps;
    const userId = ctx.user.userId;

    const open = await db
      .from('data_exports')
      .select('id')
      .eq('user_id', userId)
      .in('status', OPEN)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (open.error) throw open.error;
    if (open.data) return ctx.json({ export_id: open.data.id as string }, 202);

    const exportId = ctx.deps.newId();
    const inserted = await db.from('data_exports').insert({ id: exportId, user_id: userId, status: 'queued' });
    if (inserted.error) throw inserted.error;
    await ctx.deps.enqueue('account.export', { export_id: exportId, user_id: userId }, { retryLimit: 3 });
    return ctx.json({ export_id: exportId }, 202);
  },
});

export default handler;

// Entry point: serves the function when this file is the main module. Tests import `handler` only.
if (import.meta.main) {
  const { prodDeps } = await import('../_shared/prod.ts');
  Deno.serve((req) => handler(req, prodDeps()));
}
