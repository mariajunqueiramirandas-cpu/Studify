// Registro (security-privacy §12): every change made from the Administração, newest first.
import { useCallback, useEffect, useState } from 'react';
import type { AdminAuditEntry } from '@studify/shared';
import { callApi, messageOf } from '../../lib/api.ts';
import { AUDIT_ACTIONS, formatDateTime, formatUsd } from '../../lib/format.ts';
import { Link } from '../../lib/router.tsx';
import { Button } from '../../ui/controls.tsx';
import { Banner, Empty, Loading } from '../../ui/feedback.tsx';
import { PageHeader } from '../../ui/layout.tsx';

const PAGE = 50;

/** The details of an entry in words: money in dollars, booleans as sim/não. */
export function describeDetails(details: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue;
    const text =
      value === null ? 'padrão' : typeof value === 'boolean' ? (value ? 'sim' : 'não') : key.endsWith('micro_usd') && typeof value === 'number' ? formatUsd(value) : String(value);
    parts.push(`${LABELS[key] ?? key}: ${text}`);
  }
  return parts.join('; ');
}

const LABELS: Record<string, string> = {
  from: 'de',
  to: 'para',
  days: 'dias',
  reason: 'motivo',
  note: 'nota',
  limit_micro_usd: 'limite',
  user_day_micro_usd: 'por pessoa por dia',
  class_group_month_micro_usd: 'por turma por mês',
  global_month_micro_usd: 'teto global',
  enabled_all: 'para todos',
  percentage: 'porcentagem',
  description: 'descrição',
  blocks_older: 'exigida',
  uses: 'usos',
  expires_in_days: 'validade em dias',
  bound_to_email: 'só para um e-mail',
  display_name: 'nome',
  item_type: 'tipo',
  item_id: 'item',
};

export function Audit() {
  const [entries, setEntries] = useState<AdminAuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (before?: string) => {
    setBusy(true);
    setError(null);
    try {
      const out = await callApi<{ entries: AdminAuditEntry[] }>('admin-audit', { limit: PAGE, ...(before ? { before } : {}) });
      setEntries((current) => (before && current ? [...current, ...out.entries] : out.entries));
      setMore(out.entries.length === PAGE);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <PageHeader title="Registro" description="Tudo o que foi mudado pela Administração: quem, o quê e quando. O registro não pode ser editado nem apagado." />
      {error ? <Banner kind="danger" title="Não consegui carregar o registro." action={<Button size="sm" onClick={() => void load()}>Tentar de novo</Button>}>{error}</Banner> : null}
      {entries === null ? (
        error ? null : <Loading />
      ) : entries.length === 0 ? (
        <Empty title="Nada registrado ainda">As mudanças feitas aqui no painel aparecem nesta lista.</Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table table--stack">
              <caption className="visually-hidden">Registro da administração</caption>
              <thead>
                <tr>
                  <th scope="col">Quando</th>
                  <th scope="col">Quem</th>
                  <th scope="col">O quê</th>
                  <th scope="col">Detalhes</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((a) => (
                  <tr key={a.id}>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{formatDateTime(a.created_at)}</td>
                    <td data-label="Quem">{a.actor_id ? <Link to={`/admin/usuarios/${a.actor_id}`}>{a.actor_name ?? 'Admin'}</Link> : 'Sistema'}</td>
                    <td data-label="O quê">
                      <div className="table-primary">{AUDIT_ACTIONS[a.action] ?? a.action}</div>
                      {a.target_type === 'profile' && a.target_id ? (
                        <div className="table-secondary">
                          <Link to={`/admin/usuarios/${a.target_id}`}>Ver conta</Link>
                        </div>
                      ) : a.target_id && a.target_type !== 'settings' ? (
                        <div className="table-secondary num">{a.target_id}</div>
                      ) : null}
                    </td>
                    <td data-label="Detalhes" className="table-secondary">{describeDetails(a.details) || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {more ? (
            <div className="pager">
              <span />
              <Button size="sm" busy={busy} onClick={() => void load(entries[entries.length - 1]?.created_at)}>
                Carregar mais antigos
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
