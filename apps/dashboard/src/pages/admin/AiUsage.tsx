// Uso de IA (ai-pipeline §11): cost per day, feature, task, model and Turma; who uses most; refusals, fallbacks,
// cache reads and latency. One period filter above everything, so every number agrees.
import { useState } from 'react';
import type { AdminAiReport } from '@studify/shared';
import { callApi } from '../../lib/api.ts';
import { featureName, formatCompact, formatDay, formatInt, formatMs, formatPct, formatUsd, formatUsdTick } from '../../lib/format.ts';
import { useResource } from '../../lib/resource.ts';
import { Link } from '../../lib/router.tsx';
import { BarList, ColumnChart } from '../../ui/charts.tsx';
import { Segmented } from '../../ui/controls.tsx';
import { LoadError, Loading } from '../../ui/feedback.tsx';
import { Figure, Figures, PageHeader, Section } from '../../ui/layout.tsx';

const PERIODS = [
  { value: '7', label: '7 dias' },
  { value: '30', label: '30 dias' },
  { value: '90', label: '90 dias' },
];

export function AiUsage() {
  const [days, setDays] = useState('30');
  const res = useResource<AdminAiReport>(`admin-ai-usage:${days}`, () => callApi<AdminAiReport>('admin-ai-usage', { days: Number(days) }));
  const r = res.data;

  return (
    <div className="page">
      <PageHeader title="Uso de IA" description="Para onde vai o dinheiro de IA e como os modelos estão se saindo. Valores em dólares, como a Anthropic cobra." />
      <div className="toolbar">
        <Segmented label="Período" value={days} options={PERIODS} onChange={setDays} />
        {r ? (
          <span className="muted small">
            De {formatDay(r.from)} a {formatDay(r.to)}
          </span>
        ) : null}
      </div>
      {!r ? (
        res.error ? <LoadError error={res.error} onRetry={() => void res.reload()} /> : <Loading />
      ) : (
        <div data-refreshing={res.loading}>
          <Section title="Resumo" id="resumo">
            <div className="stack-lg">
              <Figures label="Resumo do período">
                <Figure label="Custo" value={formatUsd(r.totals.cost)} note={r.totals.calls ? `${formatUsd(r.totals.cost / r.totals.calls)} por chamada` : undefined} />
                <Figure label="Chamadas" value={formatCompact(r.totals.calls)} note={`${formatInt(r.totals.batch_calls)} em lote`} />
                <Figure label="Pessoas" value={formatInt(r.totals.users)} />
                <Figure label="Latência" value={formatMs(r.totals.p50_ms)} note={`95% abaixo de ${formatMs(r.totals.p95_ms)}`} />
                <Figure label="Leitura de cache" value={formatPct(cacheRatio(r) * 100)} note="da entrada veio do cache" />
                <Figure
                  label="Recusas"
                  value={formatInt(r.totals.refusals)}
                  note={`${formatPct(r.totals.calls ? (r.totals.refusals / r.totals.calls) * 100 : 0, { digits: 1 })} das chamadas, ${formatInt(r.totals.fallbacks)} com outro modelo`}
                />
              </Figures>
              <ColumnChart
                data={r.by_day.map((d) => ({ key: d.day, label: formatDay(d.day), title: formatDay(d.day, true), value: d.cost }))}
                format={formatUsd}
                tickFormat={formatUsdTick}
                valueLabel="Custo"
                description={`Custo de IA por dia nos últimos ${r.days} dias, em dólares`}
              />
            </div>
          </Section>

          <Section title="Por recurso" id="recursos">
            <div className="table-wrap">
              <table className="table table--stack">
                <caption className="visually-hidden">Custo e qualidade por recurso</caption>
                <thead>
                  <tr>
                    <th scope="col">Recurso</th>
                    <th scope="col" className="num">Custo</th>
                    <th scope="col" className="num">Chamadas</th>
                    <th scope="col" className="num">Recusas</th>
                    <th scope="col" className="num">Latência (p50 / p95)</th>
                    <th scope="col" className="num">Cache</th>
                  </tr>
                </thead>
                <tbody>
                  {r.by_feature.map((f) => (
                    <tr key={f.feature}>
                      <td>
                        <div className="table-primary">{featureName(f.feature)}</div>
                        <div className="table-secondary">{f.feature}</div>
                      </td>
                      <td data-label="Custo" className="num">{formatUsd(f.cost)}</td>
                      <td data-label="Chamadas" className="num">{formatInt(f.calls)}</td>
                      <td data-label="Recusas" className="num">{formatInt(f.refusals)}</td>
                      <td data-label="Latência" className="num">
                        {formatMs(f.p50_ms)} / {formatMs(f.p95_ms)}
                      </td>
                      <td data-label="Cache" className="num">{f.cache_ratio === null ? '—' : formatPct(f.cache_ratio * 100)}</td>
                    </tr>
                  ))}
                  {r.by_feature.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="muted">Nenhuma chamada no período.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Quem paga" id="quem">
            <div className="grid-2">
              <div>
                <h3 className="row-label" style={{ marginBottom: 14 }}>Pessoas que mais usam</h3>
                <BarList
                  label="Custo por pessoa"
                  items={r.top_users.map((u) => ({
                    key: u.id,
                    label: <Link to={`/admin/usuarios/${u.id}`}>{u.display_name ?? 'Conta excluída'}</Link>,
                    value: u.cost,
                    display: formatUsd(u.cost),
                  }))}
                />
              </div>
              <div>
                <h3 className="row-label" style={{ marginBottom: 14 }}>Pessoal e turmas</h3>
                <BarList
                  label="Custo por turma"
                  items={[
                    ...(r.personal_cost > 0 ? [{ key: 'personal', label: 'Matérias pessoais', value: r.personal_cost, display: formatUsd(r.personal_cost) }] : []),
                    ...r.by_class_group.map((g) => ({ key: g.id, label: g.name, value: g.cost, display: formatUsd(g.cost) })),
                  ]}
                />
              </div>
            </div>
          </Section>

          <Section title="Modelos e tarefas" id="modelos">
            <div className="grid-2">
              <div className="stack-lg">
                <div>
                  <h3 className="row-label" style={{ marginBottom: 14 }}>Por modelo que respondeu</h3>
                  <BarList label="Custo por modelo" items={r.by_model.map((m) => ({ key: m.model, label: m.model, value: m.cost, display: formatUsd(m.cost) }))} />
                </div>
                <div>
                  <h3 className="row-label" style={{ marginBottom: 14 }}>Recusas por categoria</h3>
                  <BarList
                    label="Recusas por categoria"
                    items={r.refusals_by_category.map((c) => ({ key: c.category, label: c.category, value: c.calls, display: formatInt(c.calls) }))}
                    empty="Nenhuma recusa no período."
                  />
                </div>
              </div>
              <div>
                <h3 className="row-label" style={{ marginBottom: 14 }}>Tarefas mais caras</h3>
                <BarList
                  label="Custo por tarefa"
                  items={r.by_task.map((t) => ({ key: `${t.task}:${t.feature}`, label: <>{t.task}<small>{formatMs(t.p50_ms)}</small></>, value: t.cost, display: formatUsd(t.cost) }))}
                />
              </div>
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}

function cacheRatio(r: AdminAiReport): number {
  const all = r.totals.cache_read_tokens + r.totals.cache_write_tokens + r.totals.input_tokens;
  return all > 0 ? r.totals.cache_read_tokens / all : 0;
}
