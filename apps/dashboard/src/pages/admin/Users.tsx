// Usuários: everyone with an account. Search by name, e-mail or id, filter by what needs attention, open one.
import { useEffect, useState } from 'react';
import type { AdminUserFilter, AdminUserList } from '@studify/shared';
import { callApi } from '../../lib/api.ts';
import { SCHOOL_YEARS, formatDate, formatDay, formatInt, formatRelative, formatUsd } from '../../lib/format.ts';
import { useResource } from '../../lib/resource.ts';
import { Link, navigate } from '../../lib/router.tsx';
import { Button, Segmented } from '../../ui/controls.tsx';
import { Empty, LoadError, Loading } from '../../ui/feedback.tsx';
import { Icon } from '../../ui/icons.tsx';
import { PageHeader } from '../../ui/layout.tsx';
import { UserBadges } from './common.tsx';

const FILTER_LABELS: Record<AdminUserFilter, string> = {
  all: 'Todas',
  admins: 'Admins',
  pending_names: 'Nomes em análise',
  suspended: 'Suspensas',
  minors: 'Menores de idade',
  deleting: 'Excluindo',
};
const FILTERS = Object.keys(FILTER_LABELS) as AdminUserFilter[];
const PAGE = 25;

export function Users() {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AdminUserFilter>('all');
  const [offset, setOffset] = useState(0);

  // Search after a short pause in typing, from the first page.
  useEffect(() => {
    const id = window.setTimeout(() => {
      setQuery(input.trim());
      setOffset(0);
    }, 300);
    return () => window.clearTimeout(id);
  }, [input]);

  const res = useResource<AdminUserList>(`admin-users:${filter}:${query}:${offset}`, () =>
    callApi<AdminUserList>('admin-users', { query: query || undefined, filter, limit: PAGE, offset }),
  );
  const list = res.data;

  return (
    <div className="page">
      <PageHeader title="Usuários" description="Todo mundo que tem conta no Studify. Abra uma pessoa para ver a conta, o uso de IA e as ações." />
      <div className="toolbar">
        <label className="search">
          <span className="visually-hidden">Buscar por nome, e-mail ou id</span>
          <Icon name="search" size={18} />
          <input className="input" type="search" placeholder="Buscar por nome, e-mail ou id" value={input} onChange={(e) => setInput(e.target.value)} />
        </label>
        <Segmented
          label="Filtrar"
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setOffset(0);
          }}
          options={FILTERS.map((f) => ({ value: f, label: FILTER_LABELS[f] }))}
        />
      </div>

      {!list ? (
        res.error ? <LoadError error={res.error} onRetry={() => void res.reload()} /> : <Loading />
      ) : list.rows.length === 0 ? (
        <Empty title="Ninguém encontrado">{query ? 'Confira a grafia ou busque pelo e-mail.' : 'Nenhuma conta neste filtro.'}</Empty>
      ) : (
        <div data-refreshing={res.loading}>
          <div className="table-wrap">
            <table className="table table--stack">
              <caption className="visually-hidden">Usuários</caption>
              <thead>
                <tr>
                  <th scope="col">Pessoa</th>
                  <th scope="col">Situação</th>
                  <th scope="col">Último acesso</th>
                  <th scope="col" className="num">IA em 30 dias</th>
                  <th scope="col" className="num">Turmas</th>
                  <th scope="col" className="num">Desde</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((u) => (
                  <tr key={u.id} data-href onClick={() => navigate(`/admin/usuarios/${u.id}`)}>
                    <td>
                      <div className="table-primary">
                        <Link to={`/admin/usuarios/${u.id}`} onClick={(e) => e.stopPropagation()}>
                          {u.display_name}
                        </Link>
                      </div>
                      <div className="table-secondary">
                        {u.email ?? 'sem e-mail'}
                        {u.school_year ? `, ${SCHOOL_YEARS[u.school_year]}` : ''}
                      </div>
                    </td>
                    <td data-label="Situação">
                      <UserBadges user={u} />
                    </td>
                    <td data-label="Último acesso">
                      {u.last_sign_in_at ? formatRelative(u.last_sign_in_at) : '—'}
                      {u.last_active_date ? <div className="table-secondary">estudou em {formatDay(u.last_active_date)}</div> : null}
                    </td>
                    <td data-label="IA em 30 dias" className="num">{formatUsd(u.cost_30d)}</td>
                    <td data-label="Turmas" className="num">{formatInt(u.class_groups)}</td>
                    <td data-label="Desde" className="num">{formatDate(u.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <span>
              {formatInt(list.offset + 1)} a {formatInt(list.offset + list.rows.length)} de {formatInt(list.total)}
            </span>
            <span className="inline">
              <Button size="sm" icon="left" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                Anteriores
              </Button>
              <Button size="sm" disabled={offset + PAGE >= list.total} onClick={() => setOffset(offset + PAGE)}>
                Próximas
                <Icon name="right" size={16} />
              </Button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
