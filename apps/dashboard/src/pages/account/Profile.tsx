// Perfil: name (reviewed before the Turma sees it, SP-11), school year, timezone, ENEM language and the theme of
// the app and this painel. The e-mail and the privacy acceptance are shown, not edited here.
import { useEffect, useState } from 'react';
import type { AccountOverview, AccountUpdateReq } from '@studify/shared';
import { useAccount } from '../../lib/account.tsx';
import { callApi } from '../../lib/api.ts';
import { SCHOOL_YEARS, TIME_ZONES, formatDate } from '../../lib/format.ts';
import { Button, Field, Segmented, Select, TextInput } from '../../ui/controls.tsx';
import { StatusBadge, useAction } from '../../ui/feedback.tsx';
import { PageHeader, Row, Section } from '../../ui/layout.tsx';

type Form = { display_name: string; school_year: string; timezone: string; foreign_language: string };

function formOf(account: AccountOverview): Form {
  return {
    display_name: account.profile.display_name,
    school_year: account.profile.school_year ?? '',
    timezone: account.profile.timezone,
    foreign_language: account.profile.foreign_language ?? '',
  };
}

export function Profile() {
  const { account, setAccount } = useAccount();
  const [form, setForm] = useState<Form>(() => formOf(account));
  const { busy, run } = useAction();
  useEffect(() => setForm(formOf(account)), [account]);

  const original = formOf(account);
  const name = form.display_name.trim();
  const nameError = name.length < 2 ? 'O nome precisa ter pelo menos 2 letras.' : name.length > 30 ? 'Use no máximo 30 caracteres.' : null;
  const dirty = (Object.keys(form) as Array<keyof Form>).some((k) => (k === 'display_name' ? name !== original.display_name : form[k] !== original[k]));

  const save = async () => {
    const patch: AccountUpdateReq = {};
    if (name !== original.display_name) patch.display_name = name;
    if (form.school_year !== original.school_year) patch.school_year = (form.school_year || null) as AccountUpdateReq['school_year'];
    if (form.timezone !== original.timezone) patch.timezone = form.timezone;
    if (form.foreign_language !== original.foreign_language) patch.foreign_language = (form.foreign_language || null) as AccountUpdateReq['foreign_language'];
    const next = await run('save', () => callApi<AccountOverview>('account-update', patch, { mutating: true }), patch.display_name ? 'Perfil salvo. O novo nome vai para análise.' : 'Perfil salvo.');
    if (next) setAccount(next);
  };

  const setTheme = async (theme: AccountOverview['settings']['theme']) => {
    const previous = account;
    setAccount({ ...account, settings: { ...account.settings, theme } });
    const next = await run('theme', () => callApi<AccountOverview>('account-update', { theme }, { mutating: true }));
    setAccount(next ?? previous);
  };

  const zones = TIME_ZONES.some(([z]) => z === account.profile.timezone) ? TIME_ZONES : [...TIME_ZONES, [account.profile.timezone, account.profile.timezone] as [string, string]];

  return (
    <div className="page page--narrow">
      <PageHeader title="Perfil" description="Como você aparece para a sua turma e como o Studify se ajusta a você." />

      <Section title="Seus dados" id="dados">
        <form
          className="stack-lg"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty && !nameError) void save();
          }}
        >
          <Field
            label="Nome"
            error={nameError}
            hint={
              <span className="inline">
                <NameStatus status={account.profile.display_name_status} />
                <span>A turma só vê seu nome depois que ele é aprovado. Trocar o nome manda ele de novo para análise.</span>
              </span>
            }
          >
            {({ id, describedBy, invalid }) => (
              <TextInput id={id} value={form.display_name} maxLength={30} autoComplete="nickname" aria-describedby={describedBy} aria-invalid={invalid} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
            )}
          </Field>
          <Field label="Ano escolar">
            {({ id }) => (
              <Select id={id} value={form.school_year} onChange={(e) => setForm({ ...form, school_year: e.target.value })}>
                <option value="">Prefiro não dizer</option>
                {Object.entries(SCHOOL_YEARS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Fuso horário" hint="Define quando o seu dia começa e termina: limite de IA, sequência, horário silencioso.">
            {({ id, describedBy }) => (
              <Select id={id} value={form.timezone} aria-describedby={describedBy} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
                {zones.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Língua estrangeira no ENEM">
            {({ id }) => (
              <Select id={id} value={form.foreign_language} onChange={(e) => setForm({ ...form, foreign_language: e.target.value })}>
                <option value="">Ainda não escolhi</option>
                <option value="en">Inglês</option>
                <option value="es">Espanhol</option>
              </Select>
            )}
          </Field>
          <div className="inline">
            <Button type="submit" variant="primary" busy={busy === 'save'} disabled={!dirty || Boolean(nameError)}>
              Salvar alterações
            </Button>
            {dirty ? (
              <Button variant="ghost" onClick={() => setForm(original)}>
                Desfazer
              </Button>
            ) : null}
          </div>
        </form>
      </Section>

      <Section title="Aparência" id="aparencia" description="Vale para o app e para este painel.">
        <div className="rows">
          <Row label="Tema">
            <Segmented
              label="Tema"
              value={account.settings.theme}
              onChange={(v) => void setTheme(v)}
              options={[
                { value: 'system', label: 'Automático' },
                { value: 'light', label: 'Claro' },
                { value: 'dark', label: 'Escuro' },
              ]}
            />
          </Row>
        </div>
      </Section>

      <Section title="Conta" id="conta">
        <dl className="definition">
          <dt>E-mail de acesso</dt>
          <dd>{account.profile.email ?? '—'}</dd>
          <dt>No Studify desde</dt>
          <dd>{formatDate(account.profile.created_at)}</dd>
          <dt>Aviso de privacidade</dt>
          <dd>
            Versão {account.profile.privacy_notice_version}, aceita em {formatDate(account.profile.privacy_accepted_at)}
          </dd>
          {account.profile.app_role === 'app_admin' ? (
            <>
              <dt>Papel</dt>
              <dd>Administra o Studify</dd>
            </>
          ) : null}
        </dl>
      </Section>
    </div>
  );
}

function NameStatus({ status }: { status: AccountOverview['profile']['display_name_status'] }) {
  if (status === 'approved') return <StatusBadge tone="success" icon="check">Aprovado</StatusBadge>;
  if (status === 'rejected') return <StatusBadge tone="danger" icon="alert">Recusado</StatusBadge>;
  return <StatusBadge tone="info" icon="clock">Em análise</StatusBadge>;
}
