// Privacidade e dados (SP-14, PLT-02.9): who sees what, download your data, start over, delete the account.
// Starting over and deleting ask for a fresh e-mail code (re-authentication) and a typed word, as in the app.
import { useEffect, useState, type ReactNode } from 'react';
import type { AccountOverview } from '@studify/shared';
import { useAccount, useSession } from '../../lib/account.tsx';
import { callApi, messageOf } from '../../lib/api.ts';
import { EXPORT_STATUS, formatDate, formatDateTime } from '../../lib/format.ts';
import { sendCode } from '../../lib/supabase.ts';
import { Button, Field, TextInput } from '../../ui/controls.tsx';
import { Dialog } from '../../ui/dialog.tsx';
import { Banner, StatusBadge, useAction, useToast } from '../../ui/feedback.tsx';
import { PageHeader, Row, Section } from '../../ui/layout.tsx';

type Export = AccountOverview['exports'][number];

export function Privacy() {
  const { account, setAccount, reload } = useAccount();
  const { signOut } = useSession();
  const toast = useToast();
  const { busy, run } = useAction();
  const [dialog, setDialog] = useState<'reset' | 'delete' | null>(null);
  const preparing = account.exports.some((e) => e.status === 'queued' || e.status === 'running');

  // While an archive is being prepared, look again every 10 seconds.
  useEffect(() => {
    if (!preparing) return;
    const id = window.setInterval(() => void reload().catch(() => undefined), 10_000);
    return () => window.clearInterval(id);
  }, [preparing, reload]);

  const requestExport = async () => {
    const done = await run('export', () => callApi<{ export_id: string }>('account-export', {}, { mutating: true }), 'Estou preparando seus dados. O link vale 7 dias.');
    if (done) await reload().catch(() => undefined);
  };

  const download = async (item: Export) => {
    const link = await run(item.id, () => callApi<{ url: string }>('account-export-link', { export_id: item.id }));
    if (link) window.location.assign(link.url);
  };

  return (
    <div className="page page--narrow">
      <PageHeader title="Privacidade e dados" description="O que é seu continua seu: veja quem vê o quê, baixe tudo, recomece do zero ou exclua a conta." />

      {account.deletion ? (
        <div className="banner-stack">
          <Banner kind="danger" title={`Sua conta será excluída até ${formatDate(account.deletion.completes_by)}.`}>
            Pedido feito em {formatDate(account.deletion.requested_at)}.
          </Banner>
        </div>
      ) : null}

      <Section title="Quem vê o quê" id="visibilidade">
        <ul className="stack" style={{ paddingLeft: 20, margin: 0 }}>
          <li>Suas notas, erros, respostas e progresso são só seus.</li>
          <li>A turma vê seu nome (depois de aprovado), o que você compartilhou e estatísticas sem nomes, com pelo menos 5 pessoas.</li>
          <li>Quem administra o Studify vê dados da conta para cuidar dela, como e-mail, uso de IA e turmas. Nunca suas anotações ou respostas.</li>
        </ul>
      </Section>

      <Section title="Baixar meus dados" id="exportar" description="Um arquivo .zip com tudo o que é seu, em JSON e CSV. Quando ficar pronto, o link vale 7 dias.">
        <div className="stack-lg">
          <div>
            <Button variant="primary" icon="download" busy={busy === 'export'} disabled={preparing} onClick={() => void requestExport()}>
              {preparing ? 'Preparando seus dados…' : 'Preparar meus dados'}
            </Button>
          </div>
          {account.exports.length > 0 ? (
            <ul className="list">
              {account.exports.map((item) => {
                const expired = item.status === 'expired' || (item.expires_at !== null && Date.parse(item.expires_at) <= Date.now());
                return (
                  <li key={item.id} className="list-item">
                    <div>
                      <div className="list-item-title">Pedido em {formatDateTime(item.created_at)}</div>
                      <div className="list-item-meta inline">
                        <ExportBadge status={expired ? 'expired' : item.status} />
                        {item.status === 'ready' && item.expires_at && !expired ? <span>Disponível até {formatDateTime(item.expires_at)}</span> : null}
                      </div>
                    </div>
                    <div className="list-item-actions">
                      {item.status === 'ready' && !expired ? (
                        <Button size="sm" icon="download" busy={busy === item.id} onClick={() => void download(item)}>
                          Baixar
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </Section>

      <Section title="Recomeçar do zero" id="recomecar">
        <div className="rows">
          <Row
            stack
            label="Apagar tudo e recomeçar"
            hint="Apaga matérias, materiais, cartões, revisões, progresso, XP, sequência, metas, planos, conversas e configurações. Seu login, nome e data de nascimento continuam."
          >
            <Button variant="ghost-danger" icon="refresh" disabled={Boolean(account.deletion)} onClick={() => setDialog('reset')}>
              Recomeçar do zero
            </Button>
          </Row>
        </div>
      </Section>

      <Section title="Excluir minha conta" id="excluir">
        <div className="rows">
          <Row stack label="Excluir a conta para sempre" hint="Apaga seu perfil, cartões, revisões, erros, planos e conversas. Tudo é concluído em até 15 dias e não dá pra desfazer.">
            <Button variant="danger" icon="trash" disabled={Boolean(account.deletion)} onClick={() => setDialog('delete')}>
              Excluir minha conta
            </Button>
          </Row>
        </div>
      </Section>

      <ReauthDialog
        open={dialog === 'reset'}
        onClose={() => setDialog(null)}
        email={account.profile.email}
        title="Recomeçar do zero?"
        word="ZERAR"
        confirmLabel="Apagar tudo e recomeçar"
        explain={
          <>
            <p>Vou apagar tudo o que é seu: matérias, materiais, cartões, revisões, progresso, XP, sequência, metas, planos, conversas e configurações. Isso não dá pra desfazer.</p>
            <p className="muted">Seu login, nome e data de nascimento continuam, então você não precisa de convite novo. Você sai das turmas, e o que compartilhou com elas fica para a turma.</p>
          </>
        }
        onConfirm={async (code) => {
          await callApi('account-reset', { otp_code: code }, { mutating: true });
          toast('Pronto! Sua conta está zerada.');
          setDialog(null);
          const next = await callApi<AccountOverview>('account-overview').catch(() => null);
          if (next) setAccount(next);
        }}
      />
      <ReauthDialog
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
        email={account.profile.email}
        title="Excluir sua conta?"
        word="EXCLUIR"
        confirmLabel="Excluir minha conta"
        explain={<p>Vou apagar seu perfil, cartões, revisões, erros, planos e conversas. Isso não dá pra desfazer. Tudo é concluído em até 15 dias.</p>}
        extra={(shared, setShared) => (
          <label className="checkbox">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            <span>
              Apagar também o que eu compartilhei com a turma
              <span className="field-hint" style={{ display: 'block' }}>
                Se não marcar, o material compartilhado fica com a turma e aparece como &quot;ex-membro&quot;.
              </span>
            </span>
          </label>
        )}
        onConfirm={async (code, shared) => {
          const res = await callApi<{ completes_by: string }>('account-delete', { otp_code: code, delete_shared_uploads: shared }, { mutating: true });
          await signOut('local', `Sua conta será excluída até ${formatDate(res.completes_by)}. Você recebe uma confirmação por e-mail.`);
        }}
      />
    </div>
  );
}

function ExportBadge({ status }: { status: Export['status'] }) {
  const tone = status === 'ready' ? 'success' : status === 'failed' ? 'danger' : status === 'expired' ? 'neutral' : 'info';
  const icon = status === 'ready' ? 'check' : status === 'failed' ? 'alert' : 'clock';
  return (
    <StatusBadge tone={tone} icon={status === 'expired' ? undefined : icon}>
      {EXPORT_STATUS[status]}
    </StatusBadge>
  );
}

interface ReauthProps {
  open: boolean;
  onClose: () => void;
  email: string | null;
  title: string;
  word: string;
  confirmLabel: string;
  explain: ReactNode;
  extra?: (shared: boolean, setShared: (v: boolean) => void) => ReactNode;
  onConfirm: (code: string, shared: boolean) => Promise<void>;
}

/** Explain → send a fresh e-mail code → type the code and the word → confirm. */
function ReauthDialog({ open, onClose, email, title, word, confirmLabel, explain, extra, onConfirm }: ReauthProps) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [typed, setTyped] = useState('');
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setSent(false);
    setCode('');
    setTyped('');
    setShared(false);
    setError(null);
  }, [open]);

  const send = async () => {
    if (!email) return;
    setBusy(true);
    setError(null);
    const result = await sendCode(email).catch(() => 'sent' as const);
    setBusy(false);
    if (result === 'rate_limited') setError('Muitos pedidos de código seguidos. Espere um minuto.');
    else setSent(true);
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(code, shared);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      confirm={
        sent
          ? { label: confirmLabel, variant: 'danger', busy, disabled: code.length !== 6 || typed.trim().toUpperCase() !== word, onConfirm: () => void confirm() }
          : { label: `Enviar código para ${email ?? 'seu e-mail'}`, variant: 'danger', busy, disabled: !email, onConfirm: () => void send() }
      }
    >
      <Banner kind="danger">Isso não dá pra desfazer.</Banner>
      {explain}
      {extra ? extra(shared, setShared) : null}
      {sent ? (
        <>
          <p>Enviei um código pro seu e-mail pra confirmar que é você.</p>
          <Field label="Código de 6 dígitos">
            {({ id }) => (
              <TextInput id={id} className="input-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus />
            )}
          </Field>
          <Field label={`Digite ${word} para confirmar`}>
            {({ id }) => <TextInput id={id} value={typed} autoCapitalize="characters" autoComplete="off" onChange={(e) => setTyped(e.target.value)} />}
          </Field>
        </>
      ) : null}
      {error ? <Banner kind="warning">{error}</Banner> : null}
    </Dialog>
  );
}
