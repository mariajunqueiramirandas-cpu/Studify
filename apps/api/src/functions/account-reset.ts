// account-reset (Perfil → Privacidade → Recomeçar do zero). Requires a fresh email code (re-authentication, as for
// account-delete), then wipes everything the student owns in one transaction (private.reset_account) and keeps the
// login and the profile identity, so no new invite is needed. Turma content stays with the Turma. The files of the
// removed materials and exports are deleted by the worker afterwards (account.reset_files).
import { AccountResetReqSchema, ApiFailure } from '@studify/shared';
import type { AccountResetRes } from '../shared/responses.ts';
import { defineFunction } from '../shared/http.ts';
import type { z } from 'zod';

interface ResetOutput {
  documents: Array<{ id: string; storage_path: string }>;
  exports: string[];
}

export const handler = defineFunction<z.infer<typeof AccountResetReqSchema>>({
  name: 'account-reset',
  mutating: true,
  input: AccountResetReqSchema,
  run: async (ctx) => {
    const { db } = ctx.deps;
    const user = ctx.user;
    if (!user.email) throw new ApiFailure('forbidden', { message: 'Sua conta não tem e-mail pra confirmar.' });

    const otp = await db.auth.verifyOtp({ email: user.email, token: ctx.input.otp_code, type: 'email' });
    if (otp.error) throw new ApiFailure('forbidden', { message: 'Código inválido. Pede um novo no seu e-mail.' });

    const { data, error } = await db.schema('private').rpc('reset_account', { p_user: user.userId });
    if (error) {
      if (error.message === 'owner_transfer_required') {
        throw new ApiFailure('forbidden', { message: 'Você é dono(a) de uma turma. Passe a turma pra outra pessoa antes de recomeçar do zero.' });
      }
      if (error.message === 'not_found') throw new ApiFailure('not_found');
      throw error;
    }

    const out = (data ?? { documents: [], exports: [] }) as ResetOutput;
    if (out.documents.length > 0 || out.exports.length > 0) {
      await ctx.deps.enqueue('account.reset_files', { user_id: user.userId, documents: out.documents, exports: out.exports }, { retryLimit: 5 });
    }
    const body: AccountResetRes = { reset: true };
    return ctx.json(body);
  },
});

export default handler;
