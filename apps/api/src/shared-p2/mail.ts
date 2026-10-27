// Guardian verification mail (SP-03) through the Resend REST API (POST https://api.resend.com/emails). The sign-in
// codes do not pass through here: Supabase Auth sends those itself, over Resend's SMTP (supabase/config.toml).
// A failed send throws, so guardian-link answers 5xx and the student can ask again; a repeat call rotates the token.
import type { GuardianMail } from './deps.ts';

export const DEFAULT_MAIL_FROM = 'Studify <studify@auto.vendua.com.br>';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

export function makeResendGuardianMail(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): GuardianMail {
  return async ({ guardianEmail, verifyUrl }) => {
    const link = escapeHtml(verifyUrl);
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [guardianEmail],
        subject: 'Confirme que você acompanha um(a) estudante no Studify',
        html:
          '<h2>Pedido de acompanhamento no Studify</h2>' +
          '<p>Um(a) estudante informou este e-mail como o do(a) responsável. Pra confirmar, toque no link abaixo:</p>' +
          `<p><a href="${link}">Confirmar acompanhamento</a></p>` +
          '<p>Se você não conhece esse pedido, pode ignorar este e-mail.</p>',
        text:
          'Um(a) estudante informou este e-mail como o do(a) responsável no Studify. Pra confirmar, abra:\n' +
          `${verifyUrl}\n\nSe você não conhece esse pedido, pode ignorar este e-mail.`,
      }),
    });
    if (!res.ok) throw new Error(`resend: HTTP ${res.status}`);
  };
}
