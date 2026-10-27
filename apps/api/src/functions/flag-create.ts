// flag-create (TRU-02, SP-09). A student flags an item they can see; the triage runs in the worker
// (flag.triage) and never in this request. One open flag per (item, reporter) (data-model §5.7).
import { z } from 'zod';
import { ApiFailure, FlagCreateReqSchema } from '@studify/shared';
import type { FlagCreateRes } from '../shared/responses.ts';
import { defineFunction } from '../shared/http.ts';
import { requireSubject } from '../shared/access.ts';
import { FLAG_TABLES } from '../shared/flags.ts';

type Req = z.infer<typeof FlagCreateReqSchema>;

export const handler = defineFunction<Req>({
  name: 'flag-create',
  mutating: true,
  input: FlagCreateReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    const spec = FLAG_TABLES[input.item_type];
    if (!spec) throw new ApiFailure('invalid_request', { message: 'Ainda não dá pra denunciar esse tipo de item.' });

    const item = await deps.db.from(spec.table).select(spec.select).eq('id', input.item_id).is('deleted_at', null).maybeSingle();
    if (item.error) throw item.error;
    // The select list is chosen per item type at runtime, so the row is read as a plain record.
    const row = item.data as unknown as Record<string, unknown> | null;
    if (!row) throw new ApiFailure('not_found');
    const personal = row.personal_for_user_id as string | null | undefined;
    if (personal && personal !== userId) throw new ApiFailure('not_found');
    const subject = await requireSubject(deps.db, userId, row.subject_id as string, 'read');

    const existing = await deps.db
      .from('content_flags')
      .select('id')
      .eq('item_type', input.item_type)
      .eq('item_id', input.item_id)
      .eq('reporter_id', userId)
      .in('status', ['open', 'triaged', 'hidden_pending'])
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      const body: FlagCreateRes = { flag_id: existing.data.id as string, status: 'open', hidden_for_you: false };
      return ctx.json(body);
    }

    const flagId = deps.newId();
    const version = spec.versioned ? Number(row.version ?? 1) : 1;
    const inserted = await deps.db.from('content_flags').insert({
      id: flagId,
      item_type: input.item_type,
      item_id: input.item_id,
      item_version: version,
      class_group_id: subject.owner_class_group_id,
      reporter_id: userId,
      reason: input.reason,
      comment: input.comment ?? null,
      status: 'open',
    });
    if (inserted.error) throw inserted.error;
    await deps.enqueue('flag.triage', { flag_id: flagId }, { singletonKey: flagId, retryLimit: 2 });

    const body: FlagCreateRes = { flag_id: flagId, status: 'open', hidden_for_you: false };
    return ctx.json(body);
  },
});

export default handler;
