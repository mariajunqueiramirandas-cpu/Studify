// guardian-link — SP-03 (Phase 2). Creates a pending guardian link and sends the verification mail. The response
// carries only the link id and status: no student data, and the raw verification token is never returned.
import { z } from 'zod';
import { ApiFailure } from '@studify/shared';
import { defineP2 } from '../_shared_p2/http.ts';
import { normalizeBaseUrl, randomToken, sha256Hex } from '../_shared_p2/util.ts';

export const GuardianLinkInput = z.object({ guardian_email: z.email().max(254) });
export type GuardianLinkInput = z.infer<typeof GuardianLinkInput>;

export const GUARDIAN_TOKEN_BYTES = 32;

export const handler = defineP2<GuardianLinkInput>({
  name: 'guardian-link',
  mutating: true,
  input: GuardianLinkInput,
  run: async (ctx) => {
    const { p2, input: i } = ctx;
    const db = p2.db;
    const me = ctx.user.userId;
    const email = i.guardian_email.trim().toLowerCase();
    if (ctx.user.email && ctx.user.email.toLowerCase() === email) {
      throw new ApiFailure('invalid_request', { message: 'Escolhe o e-mail de um responsável, não o seu.' });
    }

    const token = randomToken(p2.randomBytes, GUARDIAN_TOKEN_BYTES);
    const tokenHash = await sha256Hex(token);

    const open = await db
      .from('guardian_links')
      .select('id, status')
      .eq('student_id', me)
      .eq('guardian_email', email)
      .in('status', ['pending', 'active'])
      .maybeSingle();
    if (open.error) throw open.error;

    let linkId: string;
    let status: string;
    if (open.data) {
      linkId = open.data.id as string;
      status = open.data.status as string;
      if (status === 'pending') {
        const rotated = await db.from('guardian_links').update({ verify_token_hash: tokenHash }).eq('id', linkId);
        if (rotated.error) throw rotated.error;
      }
    } else {
      linkId = p2.newId();
      status = 'pending';
      const inserted = await db.from('guardian_links').insert({
        id: linkId,
        student_id: me,
        guardian_email: email,
        status,
        verify_token_hash: tokenHash,
      });
      if (inserted.error) throw inserted.error;
    }

    if (status === 'pending' && p2.guardianMail) {
      const host = normalizeBaseUrl(p2.baseUrl);
      const verifyUrl = host ? `https://${host}/guardian/${token}` : `studify://guardian/${token}`;
      await p2.guardianMail({ guardianEmail: email, verifyUrl });
    }
    return ctx.json({ link_id: linkId, status });
  },
});

if (import.meta.main) {
  const { prodP2Deps } = await import('../_shared_p2/prod.ts');
  const deps = prodP2Deps();
  Deno.serve((req) => handler(req, deps));
}
