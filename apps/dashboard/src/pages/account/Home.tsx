// Início: a short overview of the account, today's AI use as a share of the daily limit (never money, PLT-04.2),
// the study week, and the way into each setting.
import { useAccount } from '../../lib/account.tsx';
import { EXPORT_STATUS, SCHOOL_YEARS, featureName, firstName, formatDate, formatDay, formatInt, formatPct } from '../../lib/format.ts';
import { Link } from '../../lib/router.tsx';
import { BarList, ColumnChart, Meter } from '../../ui/charts.tsx';
import { Banner } from '../../ui/feedback.tsx';
import { Icon } from '../../ui/icons.tsx';
import { Figure, Figures, PageHeader, Section } from '../../ui/layout.tsx';

export function Home() {
  const { account, isAdmin } = useAccount();
  const { profile, ai_usage: usage, activity, deletion } = account;
  const lastExport = account.exports[0];

  return (
    <div className="page">
      <PageHeader
        title={`Oi, ${firstName(profile.display_name)}`}
        description="Aqui você cuida da sua conta do Studify: perfil, avisos, turmas, privacidade e os seus dados."
      />

      {deletion || profile.display_name_status !== 'approved' ? (
        <div className="banner-stack">
          {deletion ? (
            <Banner kind="danger" title={`Sua conta será excluída até ${formatDate(deletion.completes_by)}.`}>
              Pedido feito em {formatDate(deletion.requested_at)}. Você recebe uma confirmação por e-mail quando terminar.
            </Banner>
          ) : null}
          {profile.display_name_status === 'pending' ? (
            <Banner kind="info" title="Seu nome está em análise.">
              Até ser aprovado, a turma vê você sem nome. Isso costuma levar pouco tempo.
            </Banner>
          ) : null}
          {profile.display_name_status === 'rejected' ? (
            <Banner kind="warning" title="Esse nome não pode ser usado." action={<Link to="/perfil" className="btn btn-secondary btn-sm">Trocar nome</Link>}>
              Escolha outro nome para a turma ver você.
            </Banner>
          ) : null}
        </div>
      ) : null}

      <Section title="IA hoje" id="ia">
        {usage.exempt ? (
          <p className="muted">Você administra o Studify, então não tem limite diário de IA. O gasto de todo mundo fica em Administração, na página Uso de IA.</p>
        ) : (
          <div className="stack-lg">
            <div className="hero">
              <div>
                <div className="hero-label">Do seu limite de IA de hoje, você usou</div>
                <div className="hero-value">
                  <span className="marker">{formatPct(usage.today_pct)}</span>
                </div>
                <p className="hero-note">
                  {usage.today_pct >= 100
                    ? 'Seu limite de IA de hoje acabou. O que não precisa de IA continua funcionando, e o resto volta amanhã.'
                    : usage.today_pct >= 80
                      ? 'Você já usou boa parte da IA de hoje. Revisões e o que já foi gerado continuam liberados.'
                      : 'Revisões, resumos e quizzes já gerados não gastam o limite.'}
                </p>
              </div>
              <div>
                <Meter
                  ratio={usage.today_pct / 100}
                  label="Uso do limite de IA de hoje"
                  caption={
                    <>
                      <span>{formatPct(usage.today_pct)} usado</span>
                      <span>Zera à meia-noite</span>
                    </>
                  }
                />
              </div>
            </div>
            <div className="grid-2">
              <div>
                <h3 className="row-label" style={{ marginBottom: 12 }}>
                  Últimos 14 dias
                </h3>
                <ColumnChart
                  data={usage.history.map((d) => ({ key: d.day, label: formatDay(d.day), title: formatDay(d.day, true), value: d.pct }))}
                  format={(v) => formatPct(v)}
                  valueLabel="Uso do limite"
                  description="Uso do limite diário de IA nos últimos 14 dias"
                  height={170}
                />
              </div>
              <div>
                <h3 className="row-label" style={{ marginBottom: 12 }}>
                  O que usou IA hoje
                </h3>
                <BarList
                  label="Uso de IA de hoje por recurso"
                  items={usage.by_feature.map((f) => ({ key: f.feature, label: featureName(f.feature), value: f.pct, display: formatPct(f.pct) }))}
                  empty="Nada usou IA hoje ainda."
                />
              </div>
            </div>
          </div>
        )}
      </Section>

      <Section title="Sua semana de estudo" id="semana" description="Contado pelo app nos últimos 7 dias, no seu fuso horário.">
        <div className="stack-lg">
          <Figures label="Resumo da semana">
            <Figure label="Minutos estudados" value={formatInt(activity.minutes_7d)} />
            <Figure label="Revisões" value={formatInt(activity.reviews_7d)} />
            <Figure label="Sequência" value={`${formatInt(activity.streak)} ${activity.streak === 1 ? 'dia' : 'dias'}`} note={`Recorde: ${formatInt(activity.longest_streak)}`} />
          </Figures>
          <ColumnChart
            data={activity.days.map((d) => ({ key: d.day, label: formatDay(d.day), title: formatDay(d.day, true), value: d.minutes }))}
            format={(v) => `${formatInt(v)} min`}
            integer
            valueLabel="Minutos"
            description="Minutos estudados por dia nos últimos 14 dias"
            height={170}
          />
        </div>
      </Section>

      <Section title="Sua conta" id="conta">
        <nav className="rows" aria-label="Configurações da conta">
          <AccountLink to="/perfil" label="Perfil" detail={`${profile.display_name}${profile.school_year ? `, ${SCHOOL_YEARS[profile.school_year]}` : ''}`} />
          <AccountLink to="/notificacoes" label="Notificações" detail={`Horário silencioso das ${account.quiet_hours.start} às ${account.quiet_hours.end}`} />
          <AccountLink
            to="/turmas"
            label="Turmas"
            detail={account.class_groups.length === 0 ? 'Você não está em nenhuma turma' : account.class_groups.map((g) => g.name).join(', ')}
          />
          <AccountLink
            to="/dispositivos"
            label="Dispositivos"
            detail={account.devices.length === 1 ? '1 aparelho recebe notificações' : `${account.devices.length} aparelhos recebem notificações`}
          />
          <AccountLink
            to="/privacidade"
            label="Privacidade e dados"
            detail={lastExport ? `Último arquivo dos seus dados: ${EXPORT_STATUS[lastExport.status]?.toLowerCase()}, ${formatDate(lastExport.created_at)}` : 'Baixar seus dados, recomeçar do zero ou excluir a conta'}
          />
          {isAdmin ? <AccountLink to="/admin" label="Administração" detail="Você administra o Studify: pessoas, gasto de IA e moderação" /> : null}
        </nav>
      </Section>
    </div>
  );
}

function AccountLink({ to, label, detail }: { to: string; label: string; detail: string }) {
  return (
    <Link to={to} className="row">
      <div>
        <div className="row-label">{label}</div>
        <div className="row-hint">{detail}</div>
      </div>
      <div className="row-control muted">
        <Icon name="right" />
      </div>
    </Link>
  );
}
