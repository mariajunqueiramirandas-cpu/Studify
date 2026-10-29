// Notificações: the four channels (PLT-05.5) and the quiet hours (PLT-05.3). Under 18, quiet hours keep at least
// 8 hours; the API and the database check it too.
import { useEffect, useState } from 'react';
import type { AccountOverview } from '@studify/shared';
import { useAccount } from '../../lib/account.tsx';
import { callApi } from '../../lib/api.ts';
import { formatDuration, quietMinutes } from '../../lib/format.ts';
import { Button, Field, Switch, TextInput } from '../../ui/controls.tsx';
import { Banner, useAction } from '../../ui/feedback.tsx';
import { PageHeader, Row, Section } from '../../ui/layout.tsx';

type Channel = keyof AccountOverview['settings']['notifications'];
const CHANNELS: Array<{ key: Channel; label: string; hint: string }> = [
  { key: 'reviews', label: 'Revisões', hint: 'Quando há cartões para revisar.' },
  { key: 'plan', label: 'Plano de estudos', hint: 'O plano do dia, a véspera da prova e o lembrete de lançar notas.' },
  { key: 'class', label: 'Turma', hint: 'Duelos, batalhas e novidades da sua turma.' },
  { key: 'processing', label: 'Processamento', hint: 'Quando um material que você enviou fica pronto.' },
];

const MIN_MINOR_MINUTES = 8 * 60;

export function Notifications() {
  const { account, setAccount } = useAccount();
  const [start, setStart] = useState(account.quiet_hours.start);
  const [end, setEnd] = useState(account.quiet_hours.end);
  const { busy, run } = useAction();
  useEffect(() => {
    setStart(account.quiet_hours.start);
    setEnd(account.quiet_hours.end);
  }, [account.quiet_hours.start, account.quiet_hours.end]);

  const toggle = async (key: Channel, value: boolean) => {
    const previous = account;
    setAccount({ ...account, settings: { ...account.settings, notifications: { ...account.settings.notifications, [key]: value } } });
    const next = await run(key, () => callApi<AccountOverview>('account-update', { notifications: { [key]: value } }, { mutating: true }));
    setAccount(next ?? previous);
  };

  const minutes = quietMinutes(start, end);
  const tooShort = account.profile.is_minor && minutes < MIN_MINOR_MINUTES;
  const dirty = start !== account.quiet_hours.start || end !== account.quiet_hours.end;

  const saveQuiet = async () => {
    const next = await run('quiet', () => callApi<AccountOverview>('account-update', { quiet_start: start, quiet_end: end }, { mutating: true }), 'Horário silencioso salvo.');
    if (next) setAccount(next);
  };

  return (
    <div className="page page--narrow">
      <PageHeader title="Notificações" description="Escolha o que o Studify pode avisar no seu celular e quando ele fica em silêncio." />

      <Section title="O que avisar" id="canais" description="No máximo 3 avisos por dia que você não pediu. Lembretes que você marcou e material pronto não contam.">
        <div className="rows">
          {CHANNELS.map((c) => (
            <Row key={c.key} label={c.label} hint={c.hint} hintId={`hint-${c.key}`}>
              <Switch label={c.label} describedBy={`hint-${c.key}`} checked={account.settings.notifications[c.key]} disabled={busy === c.key} onChange={(v) => void toggle(c.key, v)} />
            </Row>
          ))}
        </div>
      </Section>

      <Section title="Horário silencioso" id="silencio" description="Nada chega nesse horário. O aviso mais recente de cada tipo espera o silêncio acabar.">
        <form
          className="stack-lg"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty && !tooShort) void saveQuiet();
          }}
        >
          <div className="inline" style={{ gap: 16, alignItems: 'flex-end' }}>
            <div style={{ width: 150 }}>
              <Field label="Das">{({ id }) => <TextInput id={id} type="time" value={start} required onChange={(e) => setStart(e.target.value)} />}</Field>
            </div>
            <div style={{ width: 150 }}>
              <Field label="Até">{({ id }) => <TextInput id={id} type="time" value={end} required onChange={(e) => setEnd(e.target.value)} />}</Field>
            </div>
            <p className="muted" style={{ paddingBottom: 10 }}>
              {formatDuration(minutes)} de silêncio
            </p>
          </div>
          {account.profile.is_minor ? (
            <Banner kind={tooShort ? 'warning' : 'neutral'}>Para quem tem menos de 18 anos, o horário silencioso tem pelo menos 8 horas.</Banner>
          ) : null}
          <div>
            <Button type="submit" variant="primary" busy={busy === 'quiet'} disabled={!dirty || tooShort}>
              Salvar horário
            </Button>
          </div>
        </form>
      </Section>
    </div>
  );
}
