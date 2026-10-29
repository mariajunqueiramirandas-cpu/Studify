// One person: account, AI spend and limit, activity, Turmas, devices, operations and the audit trail, with the
// owner's actions (role, name review, suspension, own daily limit). Study content is never shown.
import { useState } from 'react';
import type { AdminUserDetail } from '@studify/shared';
import { useAccount } from '../../lib/account.tsx';
import { callApi } from '../../lib/api.ts';
import {
  AUDIT_ACTIONS,
  EXPORT_STATUS,
  JOB_STATUS,
  ROLES,
  SCHOOL_YEARS,
  featureName,
  formatDate,
  formatDateTime,
  formatDay,
  formatInt,
  formatRelative,
  formatUsd,
  formatUsdTick,
  parseUsd,
  usdInput,
} from '../../lib/format.ts';
import { useResource } from '../../lib/resource.ts';
import { Link } from '../../lib/router.tsx';
import { BarList, ColumnChart } from '../../ui/charts.tsx';
import { Button, Field, MoneyInput, Select, TextArea } from '../../ui/controls.tsx';
import { Dialog } from '../../ui/dialog.tsx';
import { Banner, LoadError, Loading, useAction } from '../../ui/feedback.tsx';
import { Figure, Figures, PageHeader, Section } from '../../ui/layout.tsx';
import { UserBadges } from './common.tsx';

type Pending = 'role' | 'suspend' | 'unsuspend' | 'limit' | null;

export function UserDetail({ userId }: { userId: string }) {
  const { account } = useAccount();
  const res = useResource<AdminUserDetail>(`admin-user:${userId}`, () => callApi<AdminUserDetail>('admin-user', { user_id: userId }));
  const { busy, run } = useAction();
  const [dialog, setDialog] = useState<Pending>(null);
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('7');
  const [limit, setLimit] = useState('');

  if (!res.data) {
    return (
      <div className="page">
        <PageHeader title="Usuário" back={{ to: '/admin/usuarios', label: 'Usuários' }} />
        {res.error ? <LoadError error={res.error} onRetry={() => void res.reload()} /> : <Loading />}
      </div>
    );
  }
  const u = res.data;
  const self = u.profile.id === account.profile.id;
  const suspended = u.auth?.banned_until ? Date.parse(u.auth.banned_until) > Date.now() : false;
  const isAdmin = u.profile.app_role === 'app_admin';

  const act = async (key: string, body: Record<string, unknown>, success: string) => {
    const next = await run(key, () => callApi<AdminUserDetail>('admin-user-control', { user_id: userId, ...body }, { mutating: true }), success);
    if (next) {
      res.set(next);
      setDialog(null);
    }
    return next;
  };

  const parsedLimit = limit.trim() === '' ? null : parseUsd(limit);

  return (
    <div className="page" data-refreshing={res.loading}>
      <PageHeader
        back={{ to: '/admin/usuarios', label: 'Usuários' }}
        title={u.profile.display_name}
        description={
          <span className="stack" style={{ gap: 8 }}>
            <span>{u.auth?.email ?? 'Sem e-mail de acesso'}</span>
            <UserBadges user={{ ...u.profile, banned_until: u.auth?.banned_until ?? null, deletion_pending: u.deletion?.status === 'pending' || u.deletion?.status === 'running' }} />
          </span>
        }
        actions={
          <>
            {u.profile.display_name_status !== 'approved' ? (
              <Button size="sm" variant="primary" icon="check" busy={busy === 'approve'} onClick={() => void act('approve', { action: 'approve_name' }, 'Nome aprovado.')}>
                Aprovar nome
              </Button>
            ) : null}
            {u.profile.display_name_status !== 'rejected' ? (
              <Button size="sm" busy={busy === 'reject'} onClick={() => void act('reject', { action: 'reject_name' }, 'Nome recusado. A pessoa vai precisar escolher outro.')}>
                Recusar nome
              </Button>
            ) : null}
            <Button size="sm" disabled={self} title={self ? 'Você não pode mudar o seu próprio papel.' : undefined} onClick={() => setDialog('role')}>
              {isAdmin ? 'Tirar acesso de admin' : 'Tornar admin'}
            </Button>
            {suspended ? (
              <Button size="sm" onClick={() => setDialog('unsuspend')}>
                Reativar conta
              </Button>
            ) : (
              <Button size="sm" variant="ghost-danger" icon="ban" disabled={self || isAdmin} title={isAdmin ? 'Tire o acesso de admin antes de suspender.' : undefined} onClick={() => setDialog('suspend')}>
                Suspender
              </Button>
            )}
          </>
        }
      />

      {suspended || u.deletion ? (
        <div className="banner-stack">
          {suspended ? <Banner kind="danger" title={`Conta suspensa até ${formatDate(u.auth?.banned_until)}.`}>A pessoa não consegue entrar no app nem neste painel.</Banner> : null}
          {u.deletion ? (
            <Banner kind={u.deletion.status === 'failed' ? 'danger' : 'warning'} title={u.deletion.status === 'done' ? 'Conta excluída.' : u.deletion.status === 'failed' ? 'A exclusão desta conta falhou.' : 'Exclusão da conta em andamento.'}>
              Pedida {u.deletion.requested_by === 'guardian' ? 'pelo responsável' : 'pela própria pessoa'} em {formatDate(u.deletion.requested_at)}.
            </Banner>
          ) : null}
        </div>
      ) : null}

      <Section title="Uso de IA" id="ia">
        <div className="stack-lg">
          <Figures label="Uso de IA">
            <Figure label="Hoje" value={formatUsd(u.spend.today)} />
            <Figure label="Últimos 30 dias" value={formatUsd(u.spend.d30)} />
            <Figure
              label="Limite por dia"
              value={u.limit.exempt ? 'Sem limite' : formatUsd(u.limit.effective)}
              note={u.limit.exempt ? 'Admins não têm limite' : u.limit.override !== null ? 'Limite próprio' : 'Padrão de todo mundo'}
            />
          </Figures>
          <div className="inline">
            <Button
              size="sm"
              disabled={u.limit.exempt}
              onClick={() => {
                setLimit(usdInput(u.limit.override));
                setDialog('limit');
              }}
            >
              Mudar limite diário
            </Button>
          </div>
          <div className="grid-2">
            <ColumnChart
              data={u.spend.by_day.map((d) => ({ key: d.day, label: formatDay(d.day), title: formatDay(d.day, true), value: d.cost }))}
              format={formatUsd}
              tickFormat={formatUsdTick}
              valueLabel="Gasto"
              description={`Gasto de IA de ${u.profile.display_name} por dia nos últimos 30 dias`}
              height={170}
            />
            <BarList
              label="Gasto de 30 dias por recurso"
              items={u.spend.by_feature.map((f) => ({ key: f.feature, label: featureName(f.feature), value: f.cost, display: formatUsd(f.cost) }))}
              empty="Sem uso de IA nos últimos 30 dias."
            />
          </div>
        </div>
      </Section>

      <Section title="Conta" id="conta">
        <div className="grid-2">
          <dl className="definition">
            <dt>Entrou pela última vez</dt>
            <dd>{u.auth?.last_sign_in_at ? formatRelative(u.auth.last_sign_in_at) : 'Nunca'}</dd>
            <dt>Conta criada</dt>
            <dd>{formatDate(u.profile.created_at)}</dd>
            <dt>Ano escolar</dt>
            <dd>{u.profile.school_year ? SCHOOL_YEARS[u.profile.school_year] : '—'}</dd>
            <dt>Nascimento</dt>
            <dd>
              {String(u.profile.birth_month).padStart(2, '0')}/{u.profile.birth_year}
            </dd>
            <dt>Fuso horário</dt>
            <dd>{u.profile.timezone}</dd>
            <dt>Aviso de privacidade</dt>
            <dd>
              Versão {u.profile.privacy_notice_version}, {formatDate(u.profile.privacy_accepted_at)}
            </dd>
          </dl>
          <dl className="definition">
            <dt>Sequência</dt>
            <dd>{formatInt(u.activity.streak ?? 0)} dias (recorde {formatInt(u.activity.longest_streak ?? 0)})</dd>
            <dt>Estudou por último</dt>
            <dd>{u.activity.last_active_date ? formatDay(u.activity.last_active_date) : 'Ainda não'}</dd>
            <dt>Últimos 7 dias</dt>
            <dd>
              {formatInt(u.activity.minutes_7d)} min, {formatInt(u.activity.reviews_7d)} revisões
            </dd>
            <dt>Matérias e materiais</dt>
            <dd>
              {formatInt(u.activity.subjects)} matérias, {formatInt(u.activity.documents)} materiais
            </dd>
            <dt>Denúncias</dt>
            <dd>
              Fez {formatInt(u.reports.made)}, recebeu {formatInt(u.reports.received)}
              {u.reports.open_received > 0 ? ` (${formatInt(u.reports.open_received)} em aberto)` : ''}
            </dd>
          </dl>
        </div>
      </Section>

      <Section title="Turmas e aparelhos" id="turmas">
        <div className="grid-2">
          <div>
            <h3 className="row-label" style={{ marginBottom: 8 }}>Turmas</h3>
            {u.class_groups.length === 0 ? (
              <p className="muted">Não está em nenhuma turma.</p>
            ) : (
              <ul className="list">
                {u.class_groups.map((g) => (
                  <li key={g.id} className="list-item">
                    <div>
                      <div className="list-item-title">{g.name}</div>
                      <div className="list-item-meta">
                        {ROLES[g.role] ?? g.role}, {g.status === 'active' ? `desde ${formatDate(g.joined_at)}` : g.status}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="row-label" style={{ marginBottom: 8 }}>Aparelhos com notificações</h3>
            {u.devices.length === 0 ? (
              <p className="muted">Nenhum aparelho.</p>
            ) : (
              <ul className="list">
                {u.devices.map((d) => (
                  <li key={d.device_id} className="list-item">
                    <div>
                      <div className="list-item-title">
                        {d.platform === 'ios' ? 'iPhone' : 'Android'}
                        {d.app_version ? `, app ${d.app_version}` : ''}
                      </div>
                      <div className="list-item-meta">{d.invalidated_at ? `Desligado ${formatRelative(d.invalidated_at)}` : `Usado ${formatRelative(d.last_seen_at)}`}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Section>

      <Section title="Operações e dados" id="operacoes">
        <div className="grid-2">
          <div>
            <h3 className="row-label" style={{ marginBottom: 8 }}>Últimas operações</h3>
            {u.jobs.length === 0 ? (
              <p className="muted">Nenhuma operação.</p>
            ) : (
              <ul className="list">
                {u.jobs.map((j) => (
                  <li key={j.id} className="list-item">
                    <div>
                      <div className="list-item-title">{j.type}</div>
                      <div className="list-item-meta">
                        {JOB_STATUS[j.status] ?? j.status}
                        {j.error_code ? `, erro ${j.error_code}` : ''}, {formatRelative(j.created_at)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="row-label" style={{ marginBottom: 8 }}>Exportações de dados</h3>
            {u.exports.length === 0 ? (
              <p className="muted">Nunca pediu.</p>
            ) : (
              <ul className="list">
                {u.exports.map((e) => (
                  <li key={e.id} className="list-item">
                    <div>
                      <div className="list-item-title">{EXPORT_STATUS[e.status] ?? e.status}</div>
                      <div className="list-item-meta">Pedida em {formatDateTime(e.created_at)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Section>

      <Section title="Registro" id="registro" description="O que a administração fez nesta conta.">
        {u.audit.length === 0 ? (
          <p className="muted">Nenhuma ação registrada.</p>
        ) : (
          <ul className="list">
            {u.audit.map((a) => (
              <li key={a.id} className="list-item">
                <div>
                  <div className="list-item-title">{AUDIT_ACTIONS[a.action] ?? a.action}</div>
                  <div className="list-item-meta">
                    {a.actor_name ?? 'Admin removido'}, {formatDateTime(a.created_at)}
                    {typeof a.details.reason === 'string' ? `. Motivo: ${a.details.reason}` : ''}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="small" style={{ marginTop: 12 }}>
          <Link to="/admin/registro">Ver o registro completo</Link>
        </p>
      </Section>

      <Dialog
        open={dialog === 'role'}
        title={isAdmin ? `Tirar o acesso de admin de ${u.profile.display_name}?` : `Tornar ${u.profile.display_name} admin?`}
        onClose={() => setDialog(null)}
        confirm={{
          label: isAdmin ? 'Tirar acesso' : 'Tornar admin',
          variant: isAdmin ? 'danger' : 'primary',
          busy: busy === 'role',
          onConfirm: () => void act('role', { action: 'set_role', role: isAdmin ? 'user' : 'app_admin' }, isAdmin ? 'Acesso de admin removido.' : 'Agora essa pessoa administra o Studify.'),
        }}
      >
        {isAdmin ? (
          <p>A pessoa deixa de ver a Administração e volta a ter o limite diário de IA.</p>
        ) : (
          <p>Admins veem os dados de conta de todo mundo, mudam limites e moderam. Também não têm limite de IA. Dê esse acesso só a quem organiza o Studify com você.</p>
        )}
      </Dialog>

      <Dialog
        open={dialog === 'suspend'}
        title={`Suspender ${u.profile.display_name}?`}
        onClose={() => setDialog(null)}
        confirm={{
          label: 'Suspender conta',
          variant: 'danger',
          busy: busy === 'suspend',
          disabled: reason.trim().length < 3,
          onConfirm: () => void act('suspend', { action: 'suspend', days: days === 'indefinite' ? null : Number(days), reason: reason.trim() }, 'Conta suspensa.'),
        }}
      >
        <p>A pessoa sai do app e do painel na hora e não consegue entrar enquanto durar a suspensão. Nada é apagado.</p>
        <Field label="Por quanto tempo">
          {({ id }) => (
            <Select id={id} value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="1">1 dia</option>
              <option value="7">7 dias</option>
              <option value="30">30 dias</option>
              <option value="indefinite">Até eu reativar</option>
            </Select>
          )}
        </Field>
        <Field label="Motivo" hint="Fica no registro de moderação por 5 anos. Escreva o que aconteceu, sem dados pessoais desnecessários.">
          {({ id, describedBy }) => <TextArea id={id} value={reason} maxLength={500} aria-describedby={describedBy} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </Dialog>

      <Dialog
        open={dialog === 'unsuspend'}
        title={`Reativar ${u.profile.display_name}?`}
        onClose={() => setDialog(null)}
        confirm={{ label: 'Reativar conta', busy: busy === 'unsuspend', onConfirm: () => void act('unsuspend', { action: 'unsuspend' }, 'Conta reativada.') }}
      >
        <p>A pessoa volta a conseguir entrar no app e no painel.</p>
      </Dialog>

      <Dialog
        open={dialog === 'limit'}
        title="Limite diário de IA desta pessoa"
        onClose={() => setDialog(null)}
        confirm={{
          label: parsedLimit === null && limit.trim() === '' ? 'Usar o padrão' : 'Salvar limite',
          busy: busy === 'limit',
          disabled: limit.trim() !== '' && parsedLimit === null,
          onConfirm: () => void act('limit', { action: 'set_daily_limit', limit_micro_usd: parsedLimit }, 'Limite salvo. Já vale para hoje.'),
        }}
      >
        <p>Deixe em branco para usar o padrão de todo mundo. O novo limite já vale para hoje.</p>
        <Field label="Limite por dia" error={limit.trim() !== '' && parsedLimit === null ? 'Digite um valor como 1,50.' : null}>
          {({ id, describedBy, invalid }) => <MoneyInput id={id} value={limit} placeholder="padrão" aria-describedby={describedBy} aria-invalid={invalid} onChange={(e) => setLimit(e.target.value)} />}
        </Field>
      </Dialog>
    </div>
  );
}
