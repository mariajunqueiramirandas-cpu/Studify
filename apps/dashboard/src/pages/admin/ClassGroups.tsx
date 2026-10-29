// Turmas (PLT-04.5, PLT-04.6): every Turma with its owner, members, this month's shared AI spend against its
// monthly limit, and the limit itself.
import { useState } from 'react';
import type { AdminClassGroupRow, AdminClassGroups as Data } from '@studify/shared';
import { callApi } from '../../lib/api.ts';
import { formatDate, formatInt, formatPct, formatUsd, parseUsd, usdInput } from '../../lib/format.ts';
import { useResource } from '../../lib/resource.ts';
import { Link } from '../../lib/router.tsx';
import { Meter } from '../../ui/charts.tsx';
import { Button, Field, MoneyInput } from '../../ui/controls.tsx';
import { Dialog } from '../../ui/dialog.tsx';
import { Empty, LoadError, Loading, StatusBadge, useAction } from '../../ui/feedback.tsx';
import { PageHeader } from '../../ui/layout.tsx';

export function AdminClassGroups() {
  const res = useResource<Data>('admin-class-groups', () => callApi<Data>('admin-class-groups'));
  const { busy, run } = useAction();
  const [editing, setEditing] = useState<AdminClassGroupRow | null>(null);
  const [value, setValue] = useState('');
  const parsed = value.trim() === '' ? null : parseUsd(value);

  const save = async () => {
    if (!editing) return;
    const next = await run('save', () => callApi<Data>('admin-class-group-control', { action: 'set_budget', class_group_id: editing.id, limit_micro_usd: parsed }, { mutating: true }), 'Limite da turma salvo. Já vale para este mês.');
    if (next) {
      res.set(next);
      setEditing(null);
    }
  };

  const data = res.data;
  return (
    <div className="page">
      <PageHeader title="Turmas" description="O que é compartilhado numa turma gasta do limite mensal dela, não do limite de quem enviou." />
      {!data ? (
        res.error ? <LoadError error={res.error} onRetry={() => void res.reload()} /> : <Loading />
      ) : data.class_groups.length === 0 ? (
        <Empty title="Nenhuma turma ainda">As turmas aparecem aqui quando alguém cria uma pelo app.</Empty>
      ) : (
        <div className="table-wrap" data-refreshing={res.loading}>
          <table className="table table--stack">
            <caption className="visually-hidden">Turmas</caption>
            <thead>
              <tr>
                <th scope="col">Turma</th>
                <th scope="col" className="num">Pessoas</th>
                <th scope="col" className="num">Matérias</th>
                <th scope="col" style={{ minWidth: 220 }}>IA no mês</th>
                <th scope="col" className="num">Criada</th>
                <th scope="col"><span className="visually-hidden">Ações</span></th>
              </tr>
            </thead>
            <tbody>
              {data.class_groups.map((g) => (
                <tr key={g.id}>
                  <td>
                    <div className="table-primary">{g.name}</div>
                    <div className="table-secondary">
                      Dona(o): <Link to={`/admin/usuarios/${g.owner_id}`}>{g.owner_name ?? 'conta'}</Link>
                      {g.school ? `, ${g.school}` : ''}
                    </div>
                    {g.open_reports > 0 ? (
                      <div style={{ marginTop: 6 }}>
                        <StatusBadge tone="warning" icon="flag">{`${formatInt(g.open_reports)} ${g.open_reports === 1 ? 'denúncia' : 'denúncias'}`}</StatusBadge>
                      </div>
                    ) : null}
                  </td>
                  <td data-label="Pessoas" className="num">
                    {formatInt(g.members)}
                    {g.pending > 0 ? <div className="table-secondary">+{formatInt(g.pending)} esperando</div> : null}
                  </td>
                  <td data-label="Matérias" className="num">{formatInt(g.subjects)}</td>
                  <td data-label="IA no mês">
                    <Meter
                      small
                      ratio={g.budget_limit > 0 ? g.cost_month / g.budget_limit : 1}
                      label={`Uso do limite de ${g.name}`}
                      caption={
                        <>
                          <span>
                            {formatUsd(g.cost_month)} de {formatUsd(g.budget_limit)}
                          </span>
                          <span>{g.budget_override === null ? 'padrão' : 'limite próprio'}</span>
                        </>
                      }
                    />
                  </td>
                  <td data-label="Criada" className="num">{formatDate(g.created_at)}</td>
                  <td>
                    <Button
                      size="sm"
                      onClick={() => {
                        setValue(usdInput(g.budget_override));
                        setEditing(g);
                      }}
                    >
                      Mudar limite
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small" style={{ marginTop: 12 }}>
            Limite padrão por turma: {formatUsd(data.default_limit)} por mês. Mude em Configurações.
          </p>
        </div>
      )}

      <Dialog
        open={editing !== null}
        title={`Limite mensal de ${editing?.name ?? ''}`}
        onClose={() => setEditing(null)}
        confirm={{
          label: value.trim() === '' ? 'Usar o padrão' : 'Salvar limite',
          busy: busy === 'save',
          disabled: value.trim() !== '' && parsed === null,
          onConfirm: () => void save(),
        }}
      >
        <p>
          Deixe em branco para usar o padrão ({formatUsd(data?.default_limit ?? 0)}). Neste mês a turma já gastou {formatUsd(editing?.cost_month ?? 0)}
          {editing && editing.budget_limit > 0 ? ` (${formatPct((editing.cost_month / editing.budget_limit) * 100)} do limite atual)` : ''}.
        </p>
        <Field label="Limite por mês" error={value.trim() !== '' && parsed === null ? 'Digite um valor como 25,00.' : null}>
          {({ id, describedBy, invalid }) => <MoneyInput id={id} value={value} placeholder="padrão" aria-describedby={describedBy} aria-invalid={invalid} onChange={(e) => setValue(e.target.value)} />}
        </Field>
      </Dialog>
    </div>
  );
}
