// account-delete (SP-14, PLT-02.9). Requires a fresh email code (re-authentication), signs every session
// out, and queues the deletion. The worker finishes within 15 days (security-privacy §10).
import { AccountDeleteReqSchema, ApiFailure, } from '@studify/shared';
import type { AccountDeleteRes } from '../shared/responses.ts';
import { defineFunction } from '../shared/http.ts';
import type { z } from 'zod';

const COMPLETE_WITHIN_DAYS = 15;

export const handler = defineFunction<z.infer<typeof AccountDeleteReqSchema>>({
  name: 'account-delete',
  mutating: true,
  input: AccountDeleteReqSchema,
  run: async (ctx) => {
    const { db } = ctx.deps;
    const user = ctx.user;
    if (!user.email) throw new ApiFailure('forbidden', { message: 'Sua conta não tem e-mail pra confirmar a exclusão.' });

    if (!(await ctx.deps.verifyEmailCode(user.email, ctx.input.otp_code))) throw new ApiFailure('forbidden', { message: 'Código inválido. Pede um novo no seu e-mail.' });

    const deletionId = ctx.deps.newId();
    const inserted = await db.from('account_deletions').insert({
      id: deletionId,
      user_id: user.userId,
      requested_by: 'self',
      delete_shared_uploads: ctx.input.delete_shared_uploads,
      status: 'pending',
      requested_at: ctx.now.toISOString(),
    });
    if (inserted.error) throw inserted.error;

    await ctx.deps.enqueue('account.delete', { deletion_id: deletionId, user_id: user.userId }, { retryLimit: 5 });

    // Global sign-out: every refresh token is revoked (security-privacy §3). Failure is logged; the job still runs.
    const signedOut = await db.auth.admin.signOut(user.jwt, 'global');
    if (signedOut.error) console.error('account-delete: global sign-out failed', signedOut.error.message);

    const completesBy = new Date(ctx.now.getTime() + COMPLETE_WITHIN_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const body: AccountDeleteRes = { deletion_id: deletionId, completes_by: completesBy };
    return ctx.json(body, 202);
  },
});

export default handler;
