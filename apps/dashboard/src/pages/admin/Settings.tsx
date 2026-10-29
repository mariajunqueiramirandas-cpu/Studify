// Configurações: AI limits (PLT-04.6), feature flags (PLT-01.6) and the minimum app version (PLT-06.3).
import { useEffect, useState } from 'react';
import type { AdminLimit, AdminSettings } from '@studify/shared';
import { callApi } from '../../lib/api.ts';
import { formatDate, formatInt, formatUsd, parseUsd, usdInput } from '../../lib/format.ts';
import { useResource } from '../../lib/resource.ts';
import { Button, Field, MoneyInput, Switch, TextInput } from '../../ui/controls.tsx';
import { Banner, Empty, LoadError, Loading, StatusBadge, useAction } from '../../ui/feedback.tsx';
import { PageHeader, Row, Section } from '../../ui/layout.tsx';

type LimitKey = 'user_day' | 'class_group_month' | 'global_month';
const LIMITS: Array<{ key: LimitKey; field: string; label: string; hint: string }> = [
  { key: 'user_day', field: 'user_day_micro_usd', label: 'Por pessoa, por dia', hint: 'O que cada estudante pode gastar por dia nas próprias matérias. Zera à meia-noite de cada um.' },
  { key: 'class_group_month', field: 'class_group_month_micro_usd', label: 'Por turma, por mês', hint: 'Para o material compartilhado. Uma turma com limite próprio usa o dela.' },
  { key: 'global_month', field: 'global_month_micro_usd', label: 'Teto global, por mês', hint: 'Somando todo mundo. Quando acaba, a IA para para os estudantes até o mês virar.' },
];

type Settings = AdminSettings;

export function Settings() {
  const res = useResource<Settings>('admin-settings', () => callApi<Settings>('admin-settings'));
  const s = res.data;
  return (
    <div className="page page--narrow">
      <PageHeader title="Configurações" description="Limites de IA, recursos liberados aos poucos e a versão mínima do app." />
      {!s ? (
        res.error ? <LoadError error={res.error} onRetry={() => void res.reload()} /> : <Loading />
      ) : (
        <div data-refreshing={res.loading}>
          <LimitsForm limits={s.limits} onSaved={res.set} />
          <FlagsSection flags={s.flags} onSaved={res.set} />
          <VersionsSection versions={s.versions} onSaved={res.set} />
        </div>
      )}
    </div>
  );
}

function LimitsForm({ limits, onSaved }: { limits: Settings['limits']; onSaved: (s: Settings) => void }) {
  const initial = (l: AdminLimit) => usdInput(l.configured);
  const [values, setValues] = useState<Record<LimitKey, string>>(() => ({ user_day: initial(limits.user_day), class_group_month: initial(limits.class_group_month), global_month: initial(limits.global_month) }));
  const { busy, run } = useAction();
  useEffect(() => setValues({ user_day: initial(limits.user_day), class_group_month: initial(limits.class_group_month), global_month: initial(limits.global_month) }), [limits]);

  const parsed = (key: LimitKey) => (values[key].trim() === '' ? null : parseUsd(values[key]));
  const invalid = (key: LimitKey) => values[key].trim() !== '' && parsed(key) === null;
  const changed = LIMITS.filter(({ key }) => !invalid(key) && parsed(key) !== limits[key].configured);

  const save = async () => {
    const body: Record<string, unknown> = { action: 'set_limits' };
    for (const { key, field } of changed) body[field] = parsed(key);
    const out = await run('limits', () => callApi<{ settings: Settings }>('admin-settings-control', body, { mutating: true }), 'Limites salvos. Já valem para hoje e para este mês.');
    if (out) onSaved(out.settings);
  };

  return (
    <Section title="Limites de IA" id="limites" description="Valores em dólares. Deixe em branco para usar o padrão do sistema. Admins não têm limite.">
      <form
        className="rows"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed.length > 0 && !LIMITS.some(({ key }) => invalid(key))) void save();
        }}
      >
        {LIMITS.map(({ key, label, hint }) => (
          <Row key={key} label={label} hint={<>{hint} Padrão do sistema: {formatUsd(limits[key].builtin)}.</>} stack>
            <Field label={`${label} (em dólares)`} hideLabel error={invalid(key) ? 'Digite um valor como 1,50.' : null}>
              {({ id, describedBy, invalid: bad }) => (
                <MoneyInput id={id} value={values[key]} placeholder={usdInput(limits[key].builtin)} aria-describedby={describedBy} aria-invalid={bad} onChange={(e) => setValues({ ...values, [key]: e.target.value })} />
              )}
            </Field>
          </Row>
        ))}
        <div style={{ paddingTop: 16 }} className="inline">
          <Button type="submit" variant="primary" busy={busy === 'limits'} disabled={changed.length === 0 || LIMITS.some(({ key }) => invalid(key))}>
            Salvar limites
          </Button>
          {limits.user_overrides > 0 ? (
            <span className="muted small">
              {formatInt(limits.user_overrides)} {limits.user_overrides === 1 ? 'pessoa tem' : 'pessoas têm'} limite próprio (veja em Usuários).
            </span>
          ) : null}
        </div>
      </form>
    </Section>
  );
}

function FlagsSection({ flags, onSaved }: { flags: Settings['flags']; onSaved: (s: Settings) => void }) {
  const { busy, run } = useAction();
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [percent, setPercent] = useState<Record<string, string>>({});
  const keyOk = /^[a-z][a-z0-9_]*$/.test(key) && key.length <= 60;

  const upsert = async (body: Record<string, unknown>, success: string, busyKey: string) => {
    const out = await run(busyKey, () => callApi<{ settings: Settings }>('admin-settings-control', { action: 'flag_upsert', ...body }, { mutating: true }), success);
    if (out) onSaved(out.settings);
    return out;
  };

  return (
    <Section title="Recursos" id="recursos" description="Libere um recurso do app para todo mundo ou para uma parte das pessoas, para testar com calma.">
      {flags.length === 0 ? (
        <Empty title="Nenhum recurso cadastrado">Os recursos que o app consulta aparecem aqui depois de criados.</Empty>
      ) : (
        <div className="rows">
          {flags.map((f) => {
            const draft = percent[f.key] ?? String(f.percentage);
            const pct = Number(draft);
            const pctOk = /^\d{1,3}$/.test(draft) && pct <= 100;
            return (
              <Row
                key={f.key}
                label={<span className="num">{f.key}</span>}
                hint={
                  <>
                    {f.description || 'Sem descrição.'}
                    {f.user_ids.length + f.class_group_ids.length > 0 ? ` Liberado para ${formatInt(f.user_ids.length)} pessoas e ${formatInt(f.class_group_ids.length)} turmas.` : ''}
                  </>
                }
                stack
              >
                <span className="inline" style={{ gap: 12 }}>
                  <span className="inline" style={{ gap: 8 }}>
                    <Switch label={`${f.key} para todos`} checked={f.enabled_all} disabled={busy === `all:${f.key}`} onChange={(v) => void upsert({ key: f.key, enabled_all: v }, v ? 'Liberado para todos.' : 'Não está mais liberado para todos.', `all:${f.key}`)} />
                    <span className="small">Para todos</span>
                  </span>
                  {!f.enabled_all ? (
                    <form
                      className="inline"
                      style={{ gap: 6 }}
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (pctOk) void upsert({ key: f.key, percentage: pct }, `Liberado para ${pct}% das pessoas.`, `pct:${f.key}`);
                      }}
                    >
                      <label className="visually-hidden" htmlFor={`pct-${f.key}`}>
                        Porcentagem de pessoas com {f.key}
                      </label>
                      <input id={`pct-${f.key}`} className="input num" style={{ width: 76 }} inputMode="numeric" value={draft} aria-invalid={!pctOk} onChange={(e) => setPercent({ ...percent, [f.key]: e.target.value })} />
                      <span className="small">% das pessoas</span>
                      {draft !== String(f.percentage) ? (
                        <Button type="submit" size="sm" busy={busy === `pct:${f.key}`} disabled={!pctOk}>
                          Salvar
                        </Button>
                      ) : null}
                    </form>
                  ) : null}
                </span>
              </Row>
            );
          })}
        </div>
      )}
      <form
        className="stack"
        style={{ marginTop: 24 }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!keyOk) return;
          const out = await upsert({ key, description: description.trim(), enabled_all: false, percentage: 0 }, 'Recurso criado, ainda desligado.', 'new');
          if (out) {
            setKey('');
            setDescription('');
          }
        }}
      >
        <h3 className="row-label">Novo recurso</h3>
        <div className="grid-2" style={{ gap: 16 }}>
          <Field label="Chave" hint="A mesma que o app consulta, em minúsculas e com _." error={key && !keyOk ? 'Use letras minúsculas, números e _.' : null}>
            {({ id, describedBy, invalid }) => <TextInput id={id} value={key} className="num" autoComplete="off" aria-describedby={describedBy} aria-invalid={invalid} onChange={(e) => setKey(e.target.value.trim())} />}
          </Field>
          <Field label="Descrição">{({ id }) => <TextInput id={id} value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />}</Field>
        </div>
        <div>
          <Button type="submit" busy={busy === 'new'} disabled={!keyOk}>
            Criar recurso
          </Button>
        </div>
      </form>
    </Section>
  );
}

function VersionsSection({ versions, onSaved }: { versions: Settings['versions']; onSaved: (s: Settings) => void }) {
  const { busy, run } = useAction();
  const minimum = versions.filter((v) => v.blocks_older).reduce<number | null>((max, v) => (max === null || v.version_code > max ? v.version_code : max), null);

  const toggle = async (code: number, blocks: boolean) => {
    const out = await run(`v:${code}`, () => callApi<{ settings: Settings }>('admin-settings-control', { action: 'version_block', version_code: code, blocks_older: blocks }, { mutating: true }), blocks ? 'Versão mínima atualizada.' : 'Essa versão não é mais exigida.');
    if (out) onSaved(out.settings);
  };

  return (
    <Section title="Versões do app" id="versoes" description="Quem tiver uma versão mais antiga que a mínima vê a tela de atualização obrigatória. Revisões que não sincronizaram ficam guardadas no celular.">
      {versions.length === 0 ? (
        <Empty title="Nenhuma versão publicada">As versões aparecem aqui quando um APK novo é registrado.</Empty>
      ) : (
        <div className="stack-lg">
          {minimum !== null ? <Banner kind="neutral">Versão mínima hoje: {versions.find((v) => v.version_code === minimum)?.version_name ?? minimum}.</Banner> : null}
          <div className="rows">
            {versions.map((v) => (
              <Row
                key={v.version_code}
                label={
                  <span className="inline">
                    Versão {v.version_name}
                    {v.version_code === minimum ? <StatusBadge tone="primary">Mínima</StatusBadge> : null}
                  </span>
                }
                hint={`Código ${v.version_code}, lançada em ${formatDate(v.released_at)}${v.notes_ptbr ? `. ${v.notes_ptbr}` : ''}`}
              >
                <span className="inline" style={{ gap: 8 }}>
                  <Switch label={`Exigir a versão ${v.version_name}`} checked={v.blocks_older} disabled={busy === `v:${v.version_code}`} onChange={(b) => void toggle(v.version_code, b)} />
                  <span className="small">Exigir</span>
                </span>
              </Row>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}
