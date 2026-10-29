// account-export-link (web dashboard, Minha conta; api.md §4.11). A 5-minute signed link to one of the student's
// ready data exports (SP-14). The archive itself stays in the private `exports` bucket for its 7-day window.
import { AccountExportLinkReqSchema, ApiFailure } from '@studify/shared';
import type { z } from 'zod';
import { defineFunction } from '../shared/http.ts';

const LINK_TTL_SECONDS = 300;

export const handler = defineFunction<z.infer<typeof AccountExportLinkReqSchema>>({
  name: 'account-export-link',
  mutating: false,
  input: AccountExportLinkReqSchema,
  run: async (ctx) => {
    const { db } = ctx.deps;
    const row = await db
      .from('data_exports')
      .select('id, status, storage_path, expires_at')
      .eq('id', ctx.input.export_id)
      .eq('user_id', ctx.user.userId)
      .maybeSingle();
    if (row.error) throw row.error;
    const data = row.data as { status: string; storage_path: string | null; expires_at: string | null } | null;
    if (!data) throw new ApiFailure('not_found');
    const expired = data.expires_at !== null && Date.parse(data.expires_at) <= ctx.now.getTime();
    if (data.status !== 'ready' || !data.storage_path || expired) {
      throw new ApiFailure('not_found', { message: expired ? 'Esse arquivo expirou. Peça um novo.' : 'Esse arquivo ainda não está pronto.' });
    }
    // `download` makes Storage answer with Content-Disposition: attachment and a readable file name.
    const signed = await db.storage.from('exports').createSignedUrl(data.storage_path, LINK_TTL_SECONDS, { download: 'studify-meus-dados.zip' });
    if (signed.error || !signed.data) throw new ApiFailure('not_found', { message: 'Esse arquivo não está mais disponível. Peça um novo.' });
    return ctx.json({ url: signed.data.signedUrl, expires_in: LINK_TTL_SECONDS });
  },
});

export default handler;
