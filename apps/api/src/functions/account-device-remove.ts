// account-device-remove (web dashboard, Minha conta; api.md §4.11). Stops notifications to one of the student's
// devices by invalidating its push token (PLT-05.6). The app registers a new token on its next sign-in.
import { AccountDeviceRemoveReqSchema, ApiFailure } from '@studify/shared';
import type { z } from 'zod';
import { defineFunction } from '../shared/http.ts';
import { loadAccountOverview } from '../shared/dashboard.ts';

export const handler = defineFunction<z.infer<typeof AccountDeviceRemoveReqSchema>>({
  name: 'account-device-remove',
  mutating: true,
  input: AccountDeviceRemoveReqSchema,
  run: async (ctx) => {
    const res = await ctx.deps.db
      .from('push_tokens')
      .update({ invalidated_at: ctx.now.toISOString() })
      .eq('user_id', ctx.user.userId)
      .eq('device_id', ctx.input.device_id)
      .is('invalidated_at', null)
      .select('id');
    if (res.error) throw res.error;
    if (((res.data as unknown[] | null) ?? []).length === 0) throw new ApiFailure('not_found');
    return ctx.json(await loadAccountOverview(ctx.deps, ctx.user, ctx.now));
  },
});

export default handler;
