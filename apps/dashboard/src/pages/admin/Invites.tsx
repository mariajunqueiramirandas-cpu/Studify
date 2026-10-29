// Convites (SP-02, spec 00 §8.2): pilot invites for people who are not joining through a Turma code. Single use
// for 14 days by default; optionally bound to one e-mail.
import { useState } from 'react';
import type { AdminSettings } from '@studify/shared';
import { callApi } from '../../lib/api.ts';
import { formatDate, formatInt, groupCode } from '../../lib/format.ts';
import { useResource } from '../../lib/resource.ts';
import { Button, Field, Select, TextInput } from '../../ui/controls.tsx';
import { Dialog } from '../../ui/dialog.tsx';
import { Empty, LoadError, Loading, StatusBadge, useAction, useToast } from '../../ui/feedback.tsx';
import { PageHeader, Section } from '../../ui/layout.tsx';

type Invite = AdminSettings['invites'][number];

function stateOf(invite: Invite): { label: string; tone: 'success' | 'neutral' | 'danger' } {
  if (invite.revoked_at) return { label: 'Revogado', tone: 'danger' };
  if (invite.uses_left === 0) return { label: 'Usado', tone: 'neutral' };
  if (Date.parse(invite.expires_at) <= Date.now()) return { label: 'Vencido', tone: 'neutral' };
  return { label: 'Ativo', tone: 'success' };
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function Invites() {
  const res = useResource<AdminSettings>('admin-settings', () => callApi<AdminSettings>('admin-settings'));
  const { busy, run } = useAction();
  const toast = useToast();
  const [uses, setUses] = useState('1');
  const [days, setDays] = useState('14');
  const [email, setEmail] = useState('');
  const [created, setCreated] = useState<Invite | null>(null);
  const [revoking, setRevoking] = useState<Invite | null>(null);
  const emailOk = email.trim() === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const create = async () => {
    const out = await run('create', () =>
      callApi<{ settings: AdminSettings; invite: Invite }>(
        'admin-settings-control',
        { action: 'invite_create', uses: Number(uses), expires_in_days: Number(days), ...(email.trim() ? { email: email.trim().toLowerCase() } : {}) },
        { mutating: true },
      ),
    );
    if (out) {
      res.set(out.settings);
      setCreated(out.invite);
      setEmail('');
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    const out = await run('revoke', () => callApi<{ settings: AdminSettings }>('admin-settings-control', { action: 'invite_revoke', invite_id: revoking.id }, { mutating: true }), 'Convite revogado.');
    if (out) {
      res.set(out.settings);
      setRevoking(null);
    }
  };

  const message = (invite: Invite) =>
    `Você foi convidado(a) para o Studify! Baixe o app e use o código ${groupCode(invite.code)} para criar sua conta: ${invite.link}`;

  return (
    <div className="page page--narrow">
      <PageHeader title="Convites" description="Para chamar alguém que não vai entrar pelo código de uma turma. Quem usa um convite cria a conta no app." />

      <Section title="Novo convite" id="novo">
        <form
          className="stack-lg"
          onSubmit={(e) => {
            e.preventDefault();
            if (emailOk) void create();
          }}
        >
          <div className="grid-2" style={{ gap: 16 }}>
            <Field label="Quantas pessoas podem usar">
              {({ id }) => (
                <Select id={id} value={uses} onChange={(e) => setUses(e.target.value)}>
                  {['1', '5', '10', '30', '60'].map((n) => (
                    <option key={n} value={n}>
                      {n === '1' ? '1 pessoa' : `${n} pessoas`}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Vale por">
              {({ id }) => (
                <Select id={id} value={days} onChange={(e) => setDays(e.target.value)}>
                  {['7', '14', '30', '60'].map((n) => (
                    <option key={n} value={n}>
                      {n} dias
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Field label="Só para este e-mail (opcional)" hint="Com um e-mail, o convite só funciona para quem entrar com ele." error={emailOk ? null : 'Confira o e-mail.'}>
            {({ id, describedBy, invalid }) => <TextInput id={id} type="email" value={email} autoComplete="off" aria-describedby={describedBy} aria-invalid={invalid} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <div>
            <Button type="submit" variant="primary" icon="ticket" busy={busy === 'create'} disabled={!emailOk}>
              Criar convite
            </Button>
          </div>
        </form>
      </Section>

      <Section title="Convites criados" id="lista">
        {!res.data ? (
          res.error ? <LoadError error={res.error} onRetry={() => void res.reload()} /> : <Loading />
        ) : res.data.invites.length === 0 ? (
          <Empty title="Nenhum convite ainda">Crie o primeiro acima e mande pelo WhatsApp.</Empty>
        ) : (
          <ul className="list">
            {res.data.invites.map((invite) => {
              const state = stateOf(invite);
              return (
                <li key={invite.id} className="list-item">
                  <div>
                    <div className="inline">
                      <span className="list-item-title num" style={{ fontSize: 18, letterSpacing: '0.04em' }}>
                        {groupCode(invite.code)}
                      </span>
                      <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                    </div>
                    <div className="list-item-meta">
                      {invite.uses_left === null ? 'Usos ilimitados' : `${formatInt(invite.uses_left)} ${invite.uses_left === 1 ? 'uso restante' : 'usos restantes'}`}, vence em {formatDate(invite.expires_at)}
                      {invite.email ? `, só para ${invite.email}` : ''}
                    </div>
                  </div>
                  {state.label === 'Ativo' ? (
                    <div className="list-item-actions">
                      <Button size="sm" icon="copy" onClick={() => void copy(message(invite)).then((ok) => toast(ok ? 'Mensagem copiada.' : 'Não deu para copiar. Selecione o código e copie.', ok ? 'success' : 'error'))}>
                        Copiar mensagem
                      </Button>
                      <Button size="sm" variant="ghost-danger" onClick={() => setRevoking(invite)}>
                        Revogar
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Dialog open={created !== null} title="Convite criado" onClose={() => setCreated(null)}>
        {created ? (
          <>
            <div className="code-display">
              <span className="marker">{groupCode(created.code)}</span>
            </div>
            <p className="muted">
              {created.uses_left === 1 ? 'Vale para 1 pessoa' : `Vale para ${formatInt(created.uses_left ?? 0)} pessoas`} até {formatDate(created.expires_at)}. O link abre a página de convite com o botão para baixar o app.
            </p>
            <p className="quote" style={{ fontSize: 14 }}>{message(created)}</p>
            <div className="inline">
              <Button variant="primary" icon="copy" onClick={() => void copy(message(created)).then((ok) => toast(ok ? 'Mensagem copiada.' : 'Não deu para copiar.', ok ? 'success' : 'error'))}>
                Copiar mensagem
              </Button>
              <Button icon="copy" onClick={() => void copy(created.code).then((ok) => toast(ok ? 'Código copiado.' : 'Não deu para copiar.', ok ? 'success' : 'error'))}>
                Copiar só o código
              </Button>
              <a className="btn btn-secondary" href={`https://wa.me/?text=${encodeURIComponent(message(created))}`} target="_blank" rel="noopener noreferrer">
                Mandar no WhatsApp
              </a>
            </div>
          </>
        ) : null}
      </Dialog>

      <Dialog
        open={revoking !== null}
        title={`Revogar o convite ${revoking ? groupCode(revoking.code) : ''}?`}
        onClose={() => setRevoking(null)}
        confirm={{ label: 'Revogar convite', variant: 'danger', busy: busy === 'revoke', onConfirm: () => void revoke() }}
      >
        <p>O código para de funcionar na hora. Quem já criou conta com ele continua com a conta.</p>
      </Dialog>
    </div>
  );
}
