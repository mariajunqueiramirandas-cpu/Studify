// admin-atualidades-publish (ENM-09; api §4.10). Publishes a reviewed weekly digest (push to students who opted
// in), withdraws a digest, or withdraws one item whose source was corrected or retracted (spec 09 §9): its
// practice questions disappear with it (private.is_public_question).
import { ApiFailure, AdminAtualidadesPublishReqSchema, type AdminAtualidadesPublishReq } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { requireAppAdmin } from '../shared/access.ts';

export const handler = defineFunction<AdminAtualidadesPublishReq>({
  name: 'admin-atualidades-publish',
  mutating: true,
  input: AdminAtualidadesPublishReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    await requireAppAdmin(db, ctx.user.userId);

    if (input.action === 'withdraw_item') {
      const res = await db.from('atualidades_items').update({ withdrawn: true }).eq('id', input.item_id).select('id').maybeSingle();
      if (res.error) throw res.error;
      if (!res.data) throw new ApiFailure('not_found');
      return ctx.json({ ok: true });
    }

    const digest = await db.from('atualidades_digests').select('id, status, week_start').eq('id', input.digest_id).maybeSingle();
    if (digest.error) throw digest.error;
    if (!digest.data) throw new ApiFailure('not_found');
    if (input.action === 'withdraw') {
      const res = await db.from('atualidades_digests').update({ status: 'withdrawn' }).eq('id', input.digest_id);
      if (res.error) throw res.error;
      return ctx.json({ ok: true });
    }
    if (digest.data.status === 'published') return ctx.json({ ok: true, already: true });
    const items = await db.from('atualidades_items').select('id', { count: 'exact', head: true }).eq('digest_id', input.digest_id).eq('withdrawn', false);
    if (items.error) throw items.error;
    if ((items.count ?? 0) === 0) throw new ApiFailure('invalid_request', { message: 'Esse resumo não tem itens para publicar.' });
    const res = await db.from('atualidades_digests').update({ status: 'published', published_at: ctx.now.toISOString() }).eq('id', input.digest_id);
    if (res.error) throw res.error;
    // ENM-09.5: push to the students who opted in (the worker applies preferences and quiet hours).
    await deps.enqueue('atualidades.notify', { digest_id: input.digest_id }, { singletonKey: `atualidades.notify:${input.digest_id}` });
    return ctx.json({ ok: true });
  },
});

export default handler;
