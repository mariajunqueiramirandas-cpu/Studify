// Visão geral (PLT-04.6): what needs the owner now, this month's AI spend against the global cap with the pace
// that reaches it, who studies, and how the server's operations are doing.
import type { AdminOverview } from '@studify/shared';
import { callApi } from '../../lib/api.ts';
import { featureName, formatDay, formatInt, formatPct, formatRelative, formatUsd, formatUsdTick, monthName } from '../../lib/format.ts';
import { useResource } from '../../lib/resource.ts';
import { Link } from '../../lib/router.tsx';
import { BarList, ColumnChart, Meter } from '../../ui/charts.tsx';
import { Button } from '../../ui/controls.tsx';
import { LoadError, Loading } from '../../ui/feedback.tsx';
import { Icon } from '../../ui/icons.tsx';
import { Figure, Figures, PageHeader, Section } from '../../ui/layout.tsx';
import { RefreshedAt } from './common.tsx';

interface Attention {
  level: 'critical' | 'warning' | 'good';
  text: string;
  to?: string;
  action?: string;
}

/** Month-end projection from the spend so far, at the same daily pace. */
export function projectMonth(spent: number, today: string): { projected: number; daysInMonth: number; day: number } {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { projected: d > 0 ? (spent / d) * daysInMonth : spent, daysInMonth, day: d };
}

export function attentionItems(o: AdminOverview): Attention[] {
  const items: Attention[] = [];
  const used = o.spend.cap_used ?? 0;
  const ratio = o.spend.cap > 0 ? used / o.spend.cap : 0;
  const { projected } = projectMonth(used, o.spend.today_date);
  if (ratio >= 1) items.push({ level: 'critical', text: 'O teto global do mês acabou: a IA está parada para os estudantes até o mês virar.', to: '/admin/configuracoes', action: 'Ajustar teto' });
  else if (ratio >= 0.8) items.push({ level: 'warning', text: `O gasto já passou de 80% do teto global (${formatPct(ratio * 100)}).`, to: '/admin/configuracoes', action: 'Ver limites' });
  else if (projected > o.spend.cap) items.push({ level: 'warning', text: `No ritmo atual, o teto global acaba antes do fim do mês (previsão de ${formatUsd(projected)}).`, to: '/admin/configuracoes', action: 'Ver limites' });
  if (o.ops.failed_deletions > 0) items.push({ level: 'critical', text: `${formatInt(o.ops.failed_deletions)} ${o.ops.failed_deletions === 1 ? 'exclusão de conta falhou' : 'exclusões de conta falharam'}. Elas precisam terminar em até 15 dias.`, to: '/admin/usuarios', action: 'Ver contas' });
  for (const u of o.spend.outliers_today) {
    items.push({ level: 'warning', text: `${u.display_name} gastou ${formatUsd(u.cost)} hoje, mais de 5 vezes a mediana (${formatUsd(u.median)}).`, to: `/admin/usuarios/${u.id}`, action: 'Ver pessoa' });
  }
  const reports = o.moderation.open_reports + o.moderation.escalated_reports;
  if (reports > 0) items.push({ level: 'warning', text: `${formatInt(reports)} ${reports === 1 ? 'denúncia esperando' : 'denúncias esperando'} decisão.`, to: '/admin/moderacao', action: 'Moderar' });
  if (o.moderation.open_flags > 0) items.push({ level: 'warning', text: `${formatInt(o.moderation.open_flags)} ${o.moderation.open_flags === 1 ? 'conteúdo sinalizado' : 'conteúdos sinalizados'} por estudantes.`, to: '/admin/moderacao', action: 'Moderar' });
  if (o.moderation.pending_names > 0) items.push({ level: 'warning', text: `${formatInt(o.moderation.pending_names)} ${o.moderation.pending_names === 1 ? 'nome para revisar' : 'nomes para revisar'}.`, to: '/admin/moderacao', action: 'Revisar' });
  if (o.ops.failed_jobs_24h > 0) items.push({ level: 'warning', text: `${formatInt(o.ops.failed_jobs_24h)} ${o.ops.failed_jobs_24h === 1 ? 'operação falhou' : 'operações falharam'} nas últimas 24 horas.` });
  return items;
}

const LEVEL_ICON = { critical: 'alert', warning: 'alert', good: 'check' } as const;

export function Overview() {
  const res = useResource<AdminOverview>('admin-overview', () => callApi<AdminOverview>('admin-overview'));
  if (!res.data) {
    return <div className="page">{res.error ? <LoadError error={res.error} onRetry={() => void res.reload()} /> : <Loading />}</div>;
  }
  const o = res.data;
  const used = o.spend.cap_used ?? 0;
  const ratio = o.spend.cap > 0 ? used / o.spend.cap : 0;
  const { projected, daysInMonth } = projectMonth(used, o.spend.today_date);
  const items = attentionItems(o);
  const series = o.series.map((d) => ({ key: d.day, label: formatDay(d.day), title: formatDay(d.day, true), value: d.cost }));

  return (
    <div className="page" data-refreshing={res.loading}>
      <PageHeader
        title="Visão geral"
        description="Como o Studify está hoje: o que precisa de você, o gasto de IA do mês e quem está estudando."
        actions={
          <>
            <RefreshedAt at={o.generated_at} />
            <Button size="sm" icon="refresh" busy={res.loading} onClick={() => void res.reload()}>
              Atualizar
            </Button>
          </>
        }
      />

      <Section title="Precisa de você" id="atencao">
        {items.length === 0 ? (
          <p className="status status--good">
            <Icon name="check" /> Nada pedindo sua atenção agora.
          </p>
        ) : (
          <ul className="list">
            {items.map((item) => (
              <li key={item.text} className="list-item">
                <span className={`status status--${item.level}`} style={{ fontWeight: 500 }}>
                  <Icon name={LEVEL_ICON[item.level]} label={item.level === 'critical' ? 'Urgente' : 'Atenção'} />
                  {item.text}
                </span>
                {item.to ? (
                  <div className="list-item-actions">
                    <Link to={item.to} className="btn btn-secondary btn-sm">
                      {item.action}
                    </Link>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`IA em ${monthName(o.spend.month_start)}`} id="gasto">
        <div className="stack-lg">
          <div className="hero">
            <div>
              <div className="hero-label">Gasto de IA no mês até agora</div>
              <div className="hero-value">
                <span className="marker">{formatUsd(o.spend.month)}</span>
              </div>
              <p className="hero-note">
                {formatUsd(used)} contam para o teto global. O uso de quem administra não entra no teto, mas aparece no total.
              </p>
            </div>
            <Meter
              ratio={ratio}
              label="Uso do teto global do mês"
              caption={
                <>
                  <span>
                    {formatPct(ratio * 100)} de {formatUsd(o.spend.cap)}
                  </span>
                  <span>Previsão para o mês: {formatUsd(projected)}</span>
                </>
              }
            />
          </div>
          <Figures label="Resumo">
            <Figure label="Pessoas" value={formatInt(o.users.total)} note={`${formatInt(o.users.new_7d)} novas nesta semana`} />
            <Figure label="Estudaram em 7 dias" value={formatInt(o.users.active_7d)} note={o.users.total ? `${formatPct((o.users.active_7d / o.users.total) * 100)} de todo mundo` : undefined} />
            <Figure label="Gasto de IA hoje" value={formatUsd(o.spend.today)} />
            <Figure label="Suspensas" value={formatInt(o.users.suspended)} />
          </Figures>
          <div>
            <h3 className="row-label" style={{ marginBottom: 12 }}>
              Gasto por dia, últimos 30 dias
            </h3>
            <ColumnChart
              data={series}
              format={formatUsd}
              tickFormat={formatUsdTick}
              valueLabel="Gasto"
              description="Gasto de IA por dia nos últimos 30 dias, em dólares"
              reference={{ value: o.spend.cap / daysInMonth, label: `Ritmo do teto: ${formatUsd(o.spend.cap / daysInMonth)} por dia` }}
            />
          </div>
          <div className="grid-2">
            <div>
              <h3 className="row-label" style={{ marginBottom: 14 }}>
                Recursos que mais gastam no mês
              </h3>
              <BarList
                label="Gasto do mês por recurso"
                items={o.spend.top_features.map((f) => ({ key: f.feature, label: <>{featureName(f.feature)}<small>{f.feature}</small></>, value: f.cost, display: formatUsd(f.cost) }))}
                empty="Ainda não houve gasto neste mês."
              />
            </div>
            <div>
              <h3 className="row-label" style={{ marginBottom: 14 }}>
                Turmas que mais gastam no mês
              </h3>
              <BarList
                label="Gasto do mês por turma"
                items={o.spend.top_class_groups.map((g) => ({ key: g.id, label: g.name, value: g.cost, display: formatUsd(g.cost) }))}
                empty="Nenhuma turma usou IA compartilhada neste mês."
              />
            </div>
          </div>
        </div>
      </Section>

      <Section title="Pessoas" id="pessoas" description="Estudar conta revisão, questão, sessão ou minutos no app naquele dia.">
        <div className="grid-2">
          <div>
            <h3 className="row-label" style={{ marginBottom: 12 }}>
              Estudaram por dia
            </h3>
            <ColumnChart
              data={o.series.map((d) => ({ key: d.day, label: formatDay(d.day), title: formatDay(d.day, true), value: d.active }))}
              format={(v) => formatInt(v)}
              integer
              valueLabel="Pessoas"
              description="Pessoas que estudaram por dia nos últimos 30 dias"
              height={170}
            />
          </div>
          <div>
            <h3 className="row-label" style={{ marginBottom: 12 }}>
              Cadastros por dia
            </h3>
            <ColumnChart
              data={o.series.map((d) => ({ key: d.day, label: formatDay(d.day), title: formatDay(d.day, true), value: d.signups }))}
              format={(v) => formatInt(v)}
              integer
              valueLabel="Cadastros"
              description="Cadastros por dia nos últimos 30 dias"
              height={170}
            />
          </div>
        </div>
      </Section>

      <Section title="Operações" id="operacoes" description={`Servidor na versão ${o.server.version}, no ar desde ${formatRelative(o.server.started_at)}.`}>
        <div className="stack-lg">
          <Figures label="Operações">
            <Figure label="Em andamento" value={formatInt(o.ops.running_jobs)} />
            <Figure label="Esperando limite de IA" value={formatInt(o.ops.waiting_budget_jobs)} />
            <Figure label="Exclusões de conta pendentes" value={formatInt(o.ops.pending_deletions)} />
            <Figure label="Exportações na fila" value={formatInt(o.ops.open_exports)} />
          </Figures>
          {o.ops.recent_failures.length > 0 ? (
            <div className="table-wrap">
              <table className="table table--stack">
                <caption className="visually-hidden">Últimas operações que falharam</caption>
                <thead>
                  <tr>
                    <th scope="col">Operação</th>
                    <th scope="col">Erro</th>
                    <th scope="col">Pessoa</th>
                    <th scope="col" className="num">Quando</th>
                  </tr>
                </thead>
                <tbody>
                  {o.ops.recent_failures.map((f) => (
                    <tr key={f.id}>
                      <td>
                        <div className="table-primary">{f.type}</div>
                        {f.stage ? <div className="table-secondary">{f.stage}</div> : null}
                      </td>
                      <td data-label="Erro">{f.error_code ?? '—'}</td>
                      <td data-label="Pessoa">{f.user_id ? <Link to={`/admin/usuarios/${f.user_id}`}>{f.display_name ?? 'Conta'}</Link> : '—'}</td>
                      <td data-label="Quando" className="num">
                        {formatRelative(f.updated_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">Nenhuma operação falhou recentemente.</p>
          )}
        </div>
      </Section>
    </div>
  );
}
